// Mirror of firmware/status-light/ (PlatformIO project) so the "I'll flash
// it myself" path in StatusLightFlashDialog can show buildable source instead
// of only a precompiled binary. Keep in sync with the files under
// firmware/status-light/ when that firmware changes.

export interface FirmwareSourceFile {
  path: string;
  content: string;
}

export const STATUS_LIGHT_FIRMWARE_SOURCE: FirmwareSourceFile[] = [
  {
    path: 'platformio.ini',
    content: `; ESP32-C3 Super Mini per-printer status light.
; Build:  pio run          (from this directory)
; The post-build script merges bootloader+partitions+app into a single image at
; offset 0x0 and writes it to ../../public/firmware/status-light-esp32c3.bin so
; the dashboard's Web Serial flasher can serve it (see scripts/merge_firmware.py).

[env:esp32c3]
platform = espressif32@^6.7.0
board = esp32-c3-devkitm-1
framework = arduino
monitor_speed = 115200
build_flags =
    ; Route Serial to the C3's native USB CDC so the same USB port used for
    ; flashing also carries the provisioning JSON protocol.
    -DARDUINO_USB_MODE=1
    -DARDUINO_USB_CDC_ON_BOOT=1
lib_deps =
    bblanchon/ArduinoJson@^7.0.4
extra_scripts = post:scripts/merge_firmware.py
`,
  },
  {
    path: 'src/config.h',
    content: `#pragma once

#include <Arduino.h>

// Device configuration persisted in NVS (namespace "statuslight"), written by
// the dashboard's flash dialog over USB serial (see README.md protocol).
struct DeviceConfig {
  bool valid = false;
  String wifiSsid;
  String wifiPassword;
  // Dashboard origin the device polls, e.g. "http://10.0.0.5:8080" or
  // "https://farm.example.com". https validates against the built-in public-CA
  // bundle (Let's Encrypt etc.; self-signed needs http).
  String serverUrl;
  uint32_t pollIntervalMs = 5000;
  String printerId;
  bool commonAnode = false;
};

bool configLoad(DeviceConfig &out);
void configSave(const DeviceConfig &config);
void configClear();
`,
  },
  {
    path: 'src/config.cpp',
    content: `#include "config.h"

#include <Preferences.h>

static const char *NVS_NAMESPACE = "statuslight";

bool configLoad(DeviceConfig &out) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, /*readOnly=*/true)) {
    return false;
  }
  out.wifiSsid = prefs.getString("ssid", "");
  out.wifiPassword = prefs.getString("pass", "");
  out.serverUrl = prefs.getString("srvurl", "");
  out.pollIntervalMs = prefs.getUInt("interval", 5000);
  out.printerId = prefs.getString("printer", "");
  out.commonAnode = prefs.getBool("anode", false);
  prefs.end();
  out.valid = out.wifiSsid.length() > 0 && out.serverUrl.length() > 0 && out.printerId.length() > 0;
  return out.valid;
}

void configSave(const DeviceConfig &config) {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, /*readOnly=*/false);
  prefs.putString("ssid", config.wifiSsid);
  prefs.putString("pass", config.wifiPassword);
  prefs.putString("srvurl", config.serverUrl);
  prefs.putUInt("interval", config.pollIntervalMs);
  prefs.putString("printer", config.printerId);
  prefs.putBool("anode", config.commonAnode);
  prefs.end();
}

void configClear() {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, /*readOnly=*/false);
  prefs.clear();
  prefs.end();
}
`,
  },
  {
    path: 'src/led.h',
    content: `#pragma once

#include <stdint.h>

// 4-pin analog RGB LED on three LEDC PWM channels. Patterns are non-blocking;
// call ledTick() from loop().
enum class LedPattern : uint8_t {
  Off,
  Solid,
  Blink,    // 500 ms on / 500 ms off (offline = blinking red)
  Breathe,  // slow sine-ish fade (connecting states)
};

void ledInit(bool commonAnode);
void ledSetPolarity(bool commonAnode);
void ledSet(uint8_t r, uint8_t g, uint8_t b, LedPattern pattern);
void ledTick();
`,
  },
  {
    path: 'src/led.cpp',
    content: `#include "led.h"

#include <Arduino.h>

// GPIO3/4/5: plain IOs on the C3 Super Mini — deliberately not the strapping
// pins (GPIO2/8/9) so the LED wiring can never disturb boot, and not the
// onboard LED (GPIO8).
static const int PIN_R = 3;
static const int PIN_G = 4;
static const int PIN_B = 5;

static const int CH_R = 0;
static const int CH_G = 1;
static const int CH_B = 2;

static const int PWM_FREQ_HZ = 5000;
static const int PWM_RES_BITS = 8;

static bool s_commonAnode = false;
static uint8_t s_r = 0, s_g = 0, s_b = 0;
static LedPattern s_pattern = LedPattern::Off;

static void writeRgb(uint8_t r, uint8_t g, uint8_t b) {
  // Common anode sinks current through the pins, so the duty is inverted.
  ledcWrite(CH_R, s_commonAnode ? 255 - r : r);
  ledcWrite(CH_G, s_commonAnode ? 255 - g : g);
  ledcWrite(CH_B, s_commonAnode ? 255 - b : b);
}

void ledInit(bool commonAnode) {
  s_commonAnode = commonAnode;
  ledcSetup(CH_R, PWM_FREQ_HZ, PWM_RES_BITS);
  ledcSetup(CH_G, PWM_FREQ_HZ, PWM_RES_BITS);
  ledcSetup(CH_B, PWM_FREQ_HZ, PWM_RES_BITS);
  ledcAttachPin(PIN_R, CH_R);
  ledcAttachPin(PIN_G, CH_G);
  ledcAttachPin(PIN_B, CH_B);
  writeRgb(0, 0, 0);
}

void ledSetPolarity(bool commonAnode) {
  s_commonAnode = commonAnode;
}

void ledSet(uint8_t r, uint8_t g, uint8_t b, LedPattern pattern) {
  s_r = r;
  s_g = g;
  s_b = b;
  s_pattern = pattern;
}

void ledTick() {
  const uint32_t now = millis();
  switch (s_pattern) {
    case LedPattern::Off:
      writeRgb(0, 0, 0);
      break;
    case LedPattern::Solid:
      writeRgb(s_r, s_g, s_b);
      break;
    case LedPattern::Blink: {
      const bool on = (now / 500) % 2 == 0;
      writeRgb(on ? s_r : 0, on ? s_g : 0, on ? s_b : 0);
      break;
    }
    case LedPattern::Breathe: {
      // Triangle wave over ~2 s, scaled 10–100 % so it never fully disappears.
      const uint32_t phase = now % 2000;
      const uint32_t tri = phase < 1000 ? phase : 2000 - phase; // 0..1000
      const uint32_t level = 25 + (tri * 230) / 1000;           // 25..255
      writeRgb((uint16_t)s_r * level / 255, (uint16_t)s_g * level / 255,
               (uint16_t)s_b * level / 255);
      break;
    }
  }
}
`,
  },
  {
    path: 'src/net.h',
    content: `#pragma once

#include "config.h"

enum class NetState : uint8_t {
  Idle,            // no config
  WifiConnecting,
  Polling,         // WiFi up, HTTP poll not yet succeeded (or currently failing)
  Connected,       // last poll succeeded
};

// Called after each successful status poll with the printer-status payload
// (plain string: printing|idle|paused|error|offline, or "" when the printer was
// deleted on the server).
typedef void (*StatusCallback)(const String &status);

void netBegin(const DeviceConfig &config, StatusCallback onStatus);
void netStop();
void netTick();
NetState netState();
`,
  },
  {
    path: 'src/net.cpp',
    content: `#include "net.h"

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// Embedded public-CA bundle shipped by the ESP-IDF mbedtls component (the same
// gen_crt_bundle.py format WiFiClientSecure::setCACertBundle expects); used to
// validate an https:// dashboard certificate (Let's Encrypt etc.). A
// self-signed cert won't validate — provision an http:// URL for those. The
// arduino-embed symbol \`_binary_data_cert_..._bin_start\` isn't produced in a
// PlatformIO build, so we reference the IDF bundle bytes directly.
extern const uint8_t rootca_crt_bundle_start[] asm("x509_crt_bundle");

static DeviceConfig s_config;
static StatusCallback s_onStatus = nullptr;
static NetState s_state = NetState::Idle;
static uint32_t s_wifiRetryAt = 0;
static uint32_t s_nextPollAt = 0;
static String s_statusUrl;
static bool s_https = false;

// <serverUrl>/api/status-light/printers/<printerId> — the plain-string status
// endpoint the dashboard serves (server/app.js).
static String buildStatusUrl() {
  String base = s_config.serverUrl;
  while (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base + "/api/status-light/printers/" + s_config.printerId;
}

// One GET against the status endpoint using the given (plain or TLS) client.
// On HTTP 200 with a {"status":"…"} body, hands the status to the callback.
static bool requestWith(WiFiClient &client) {
  HTTPClient http;
  http.setConnectTimeout(6000);
  http.setTimeout(6000);
  if (!http.begin(client, s_statusUrl)) {
    return false;
  }
  const int code = http.GET();
  bool ok = false;
  if (code == 200) {
    const String body = http.getString();
    JsonDocument doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      const char *status = doc["status"] | "";
      if (s_onStatus) {
        s_onStatus(String(status));
      }
      ok = true;
    }
  }
  http.end();
  return ok;
}

static bool pollStatus() {
  if (s_https) {
    WiFiClientSecure client;
    client.setCACertBundle(rootca_crt_bundle_start);
    return requestWith(client);
  }
  WiFiClient client;
  return requestWith(client);
}

void netBegin(const DeviceConfig &config, StatusCallback onStatus) {
  netStop();
  s_config = config;
  s_onStatus = onStatus;
  if (s_config.pollIntervalMs < 1000) {
    s_config.pollIntervalMs = 5000; // guard against a bad/zero provisioned value
  }
  s_statusUrl = buildStatusUrl();
  s_https = s_config.serverUrl.startsWith("https://") || s_config.serverUrl.startsWith("HTTPS://");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(s_config.wifiSsid.c_str(), s_config.wifiPassword.c_str());
  s_state = NetState::WifiConnecting;
  s_wifiRetryAt = millis() + 20000;
}

void netStop() {
  WiFi.disconnect(true);
  s_state = NetState::Idle;
}

void netTick() {
  if (s_state == NetState::Idle) {
    return;
  }
  const bool wifiUp = WiFi.status() == WL_CONNECTED;
  if (s_state == NetState::WifiConnecting) {
    if (wifiUp) {
      s_state = NetState::Polling;
      s_nextPollAt = millis(); // poll immediately once associated
    } else if ((int32_t)(millis() - s_wifiRetryAt) >= 0) {
      // Some APs need a fresh association attempt after a long failure.
      WiFi.disconnect();
      WiFi.begin(s_config.wifiSsid.c_str(), s_config.wifiPassword.c_str());
      s_wifiRetryAt = millis() + 20000;
    }
    return;
  }
  if (!wifiUp) {
    // WiFi dropped: reflect it for the LED (purple breathe) until the link
    // is back, then polling resumes.
    s_state = NetState::WifiConnecting;
    s_wifiRetryAt = millis() + 20000;
    return;
  }
  // WiFi is up: poll the dashboard on the configured cadence. A failed poll
  // drops us to Polling (keep-last color + stale hint) but keeps retrying.
  if ((int32_t)(millis() - s_nextPollAt) >= 0) {
    const bool ok = pollStatus();
    s_state = ok ? NetState::Connected : NetState::Polling;
    s_nextPollAt = millis() + s_config.pollIntervalMs;
  }
}

NetState netState() {
  return s_state;
}
`,
  },
  {
    path: 'src/provisioning.h',
    content: `#pragma once

#include "config.h"

// Called after a valid {"cmd":"provision", ...} line was saved to NVS.
typedef void (*ProvisionedCallback)(const DeviceConfig &config);

// Poll the USB serial for one-line JSON commands (provision/status/clear).
// Active in every state so a device can be re-provisioned without reflashing.
void provisioningPoll(const DeviceConfig &current, ProvisionedCallback onProvisioned);
`,
  },
  {
    path: 'src/provisioning.cpp',
    content: `#include "provisioning.h"

#include <Arduino.h>
#include <ArduinoJson.h>

#include "net.h"

static String s_lineBuffer;

static void replyError(const char *message) {
  JsonDocument doc;
  doc["ok"] = false;
  doc["error"] = message;
  serializeJson(doc, Serial);
  Serial.println();
}

static void handleLine(const String &line, const DeviceConfig &current,
                       ProvisionedCallback onProvisioned) {
  JsonDocument doc;
  if (deserializeJson(doc, line) != DeserializationError::Ok) {
    replyError("invalid json");
    return;
  }
  const char *cmd = doc["cmd"] | "";

  if (strcmp(cmd, "provision") == 0) {
    DeviceConfig config;
    config.wifiSsid = String(doc["wifiSsid"] | "");
    config.wifiPassword = String(doc["wifiPassword"] | "");
    config.serverUrl = String(doc["serverUrl"] | "");
    config.pollIntervalMs = (uint32_t)(doc["pollIntervalMs"] | 5000);
    config.printerId = String(doc["printerId"] | "");
    config.commonAnode = strcmp(doc["ledPolarity"] | "common_cathode", "common_anode") == 0;
    if (config.wifiSsid.isEmpty() || config.serverUrl.isEmpty() || config.printerId.isEmpty()) {
      replyError("wifiSsid, serverUrl and printerId are required");
      return;
    }
    config.valid = true;
    configSave(config);
    JsonDocument reply;
    reply["ok"] = true;
    reply["printerId"] = config.printerId;
    serializeJson(reply, Serial);
    Serial.println();
    if (onProvisioned) {
      onProvisioned(config);
    }
    return;
  }

  if (strcmp(cmd, "status") == 0) {
    JsonDocument reply;
    reply["ok"] = true;
    reply["configured"] = current.valid;
    reply["printerId"] = current.printerId;
    reply["serverUrl"] = current.serverUrl;
    reply["pollIntervalMs"] = current.pollIntervalMs;
    const NetState state = netState();
    reply["net"] = state == NetState::Connected      ? "connected"
                   : state == NetState::Polling        ? "polling"
                   : state == NetState::WifiConnecting ? "wifi-connecting"
                                                       : "idle";
    serializeJson(reply, Serial);
    Serial.println();
    return;
  }

  if (strcmp(cmd, "clear") == 0) {
    configClear();
    JsonDocument reply;
    reply["ok"] = true;
    serializeJson(reply, Serial);
    Serial.println();
    ESP.restart();
    return;
  }

  replyError("unknown cmd");
}

void provisioningPoll(const DeviceConfig &current, ProvisionedCallback onProvisioned) {
  while (Serial.available() > 0) {
    const char c = (char)Serial.read();
    if (c == '\\n' || c == '\\r') {
      if (s_lineBuffer.length() > 0) {
        const String line = s_lineBuffer;
        s_lineBuffer = "";
        if (line.startsWith("{")) {
          handleLine(line, current, onProvisioned);
        }
      }
      continue;
    }
    if (s_lineBuffer.length() < 2048) {
      s_lineBuffer += c;
    } else {
      s_lineBuffer = ""; // runaway line without newline — drop it
    }
  }
}
`,
  },
  {
    path: 'src/main.cpp',
    content: `// ESP32-C3 Super Mini per-printer status light for STEM Lab Print Farm.
//
// Polls GET <serverUrl>/api/status-light/printers/<printerId> on the dashboard
// (server/app.js) every pollIntervalMs and drives a 4-pin analog RGB LED:
//   idle     -> solid green         printing -> solid blue
//   paused   -> solid orange        error    -> solid red
//   offline  -> blinking red (500 ms)
// Local states: unprovisioned -> white breathe; WiFi/first-poll connecting ->
// purple breathe; polls failing -> keep last color with a purple flash every
// 5 s so a dead link is distinguishable from a healthy idle printer.

#include <Arduino.h>

#include "config.h"
#include "led.h"
#include "net.h"
#include "provisioning.h"

static DeviceConfig s_config;
static bool s_haveStatus = false;
static uint8_t s_statusR = 0, s_statusG = 0, s_statusB = 0;
static LedPattern s_statusPattern = LedPattern::Off;

static void applyStatus(const String &status) {
  s_haveStatus = true;
  if (status == "idle") {
    s_statusR = 0; s_statusG = 255; s_statusB = 0; s_statusPattern = LedPattern::Solid;
  } else if (status == "printing") {
    s_statusR = 0; s_statusG = 0; s_statusB = 255; s_statusPattern = LedPattern::Solid;
  } else if (status == "paused") {
    s_statusR = 255; s_statusG = 90; s_statusB = 0; s_statusPattern = LedPattern::Solid; // orange
  } else if (status == "error") {
    s_statusR = 255; s_statusG = 0; s_statusB = 0; s_statusPattern = LedPattern::Solid;
  } else if (status == "offline") {
    s_statusR = 255; s_statusG = 0; s_statusB = 0; s_statusPattern = LedPattern::Blink;
  } else {
    // Empty retained payload = printer deleted on the server.
    s_haveStatus = false;
  }
}

static void onProvisioned(const DeviceConfig &config) {
  s_config = config;
  s_haveStatus = false;
  ledSetPolarity(config.commonAnode);
  netBegin(s_config, applyStatus);
}

void setup() {
  Serial.begin(115200);
  const bool configured = configLoad(s_config);
  ledInit(s_config.commonAnode);
  if (configured) {
    netBegin(s_config, applyStatus);
  }
}

void loop() {
  provisioningPoll(s_config, onProvisioned);
  netTick();

  const NetState state = netState();
  if (!s_config.valid) {
    ledSet(255, 255, 255, LedPattern::Breathe); // waiting for provisioning
  } else if (state == NetState::WifiConnecting ||
             (state == NetState::Polling && !s_haveStatus)) {
    ledSet(160, 0, 255, LedPattern::Breathe); // purple: connecting
  } else if (state == NetState::Connected && !s_haveStatus) {
    ledSet(255, 255, 255, LedPattern::Breathe); // connected, no status yet
  } else if (s_haveStatus) {
    // Polls failing but we have a last-known status: keep showing it, with a
    // short purple flash every 5 s as a "stale" hint.
    if (state != NetState::Connected && (millis() % 5000) < 150) {
      ledSet(160, 0, 255, LedPattern::Solid);
    } else {
      ledSet(s_statusR, s_statusG, s_statusB, s_statusPattern);
    }
  }

  ledTick();
  delay(10);
}
`,
  },
];
