# Print-Farm Status Light (ESP32-C3 Super Mini)

Firmware for a per-printer RGB status light. The device joins WiFi, connects
to the dashboard's embedded MQTT broker (`server/statusLightBroker.js`), and
mirrors the printer's status on a 4-pin analog RGB LED module:

| Printer status | Light |
|---|---|
| idle | solid green |
| printing | solid blue |
| paused | solid orange |
| error | solid red |
| offline | blinking red (500 ms) |
| — unprovisioned | white breathe |
| — WiFi/MQTT connecting | purple breathe |
| — broker lost | last color + short purple flash every 5 s |

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

The dashboard's Printer Detail → Status Light card does this for you; the
protocol is documented for debugging. 115200 baud over the USB port, one JSON
object per line. Accepted at **any time** — re-provisioning never needs a
reflash.

```json
{"cmd":"provision","wifiSsid":"Lab-WiFi","wifiPassword":"…",
 "mqttTransport":"tcp","mqttHost":"10.0.0.5","mqttPort":1883,"mqttPath":"/mqtt",
 "mqttUsername":"statuslight","mqttPassword":"…","printerId":"printer-1",
 "ledPolarity":"common_cathode"}
```

Reply: `{"ok":true,"printerId":"printer-1"}` or `{"ok":false,"error":"…"}`.

- `mqttTransport`: `tcp` (raw MQTT, LAN, host port `MQTT_PORT`, default 1883),
  `ws` (MQTT over WebSocket at `/mqtt` on the plain-HTTP site port), or `wss`
  (same over HTTPS, port 443). `wss` validates the certificate against the
  built-in public-CA bundle — it works with Let's Encrypt-style certs, not
  self-signed ones (use `ws`/`tcp` on the LAN for those).
- The MQTT credential comes from the server (admin-only
  `GET /api/status-light/provisioning`).

Other commands: `{"cmd":"status"}` → current config/connection state,
`{"cmd":"clear"}` → wipe the stored config and reboot.

## MQTT contract

- Subscribes: `printfarm/printers/<printerId>/status` (retained, plain string).
- Publishes: `printfarm/lights/<printerId>/availability` = `online` retained on
  connect; LWT publishes `offline` when the device drops. Client id is
  `statuslight-<printerId>`, keepalive 15 s.
