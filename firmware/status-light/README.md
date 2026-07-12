# Print-Farm Status Light (ESP32-C3 Super Mini)

Firmware for a per-printer RGB status light. The device joins WiFi, then polls
the dashboard's status endpoint over plain HTTP(S)
(`GET /api/status-light/printers/<printerId>`, `server/app.js`) and mirrors the
printer's status on a 4-pin analog RGB LED module:

| Printer status | Light |
|---|---|
| idle | solid green |
| printing | solid blue |
| paused | solid orange |
| error | solid red |
| offline | blinking red (500 ms) |
| — unprovisioned | white breathe |
| — WiFi/first-poll connecting | purple breathe |
| — polls failing | last color + short purple flash every 5 s |

## Wiring

4-pin analog RGB LED module (use ~220 Ω series resistors if the module has none):

| LED pin | ESP32-C3 Super Mini |
|---|---|
| R | GPIO3 |
| G | GPIO4 |
| B | GPIO5 |
| common | GND (common cathode) **or** 3V3 (common anode) |

The polarity (cathode/anode) is chosen in the dashboard's flash dialog — no
rebuild needed. GPIO2/8/9 (strapping pins / onboard LED) are deliberately
unused.

## Build

Requires [PlatformIO](https://platformio.org) (`pip install platformio`):

```bash
cd firmware/status-light
pio run
```

The post-build script (`scripts/merge_firmware.py`) writes a **merged image**
(bootloader + partitions + app, flashable at offset `0x0`) to
`public/firmware/status-light-esp32c3.bin`, which the dashboard serves to its
Web Serial flasher. Rebuild the web image (or re-run `npm run build`) after
building so the new binary lands in `dist/`.

To flash directly without the dashboard:

```bash
pio run -t upload            # or:
esptool.py --chip esp32c3 write_flash 0x0 ../../public/firmware/status-light-esp32c3.bin
```

## Provisioning (serial protocol)

Flash and provision the device with an external tool (the dashboard has no
in-browser flasher). After flashing, send the provisioning line over the USB
serial port: 115200 baud, one JSON object per line. Accepted at **any time** —
re-provisioning never needs a reflash. Any serial terminal works (e.g.
`pio device monitor`, `screen`, or a script).

```json
{"cmd":"provision","wifiSsid":"Lab-WiFi","wifiPassword":"…",
 "serverUrl":"http://10.0.0.5:8080","pollIntervalMs":5000,
 "printerId":"printer-1","ledPolarity":"common_cathode"}
```

Reply: `{"ok":true,"printerId":"printer-1"}` or `{"ok":false,"error":"…"}`.

- `serverUrl`: the dashboard origin the device curls, e.g.
  `http://10.0.0.5:8080` or `https://farm.example.com`. An `https://` URL
  validates the certificate against the built-in public-CA bundle — it works
  with Let's Encrypt-style certs, not self-signed ones (use `http://` on the LAN
  for those).
- `pollIntervalMs`: how often to poll (default 5000, floored at 1000). The
  server's suggested default comes from admin-only
  `GET /api/status-light/provisioning`.

Other commands: `{"cmd":"status"}` → current config/connection state,
`{"cmd":"clear"}` → wipe the stored config and reboot.

## HTTP contract

- Polls: `GET <serverUrl>/api/status-light/printers/<printerId>` every
  `pollIntervalMs`; expects `200` with a JSON body
  `{"id":"…","status":"idle|printing|paused|error|offline"}` and colors the LED
  from `status`. Non-200 / timeout keeps the last color with a stale hint.
- The dashboard tracks device presence from these polls and exposes it at
  `GET /api/status-light/devices` (drives the card's Connected/Last-seen badge).
