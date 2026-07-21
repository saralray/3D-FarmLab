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
  String mqttTransport;  // "tcp" | "ws" | "wss"
  String mqttHost;
  uint16_t mqttPort = 1883;
  String mqttPath;       // ws/wss only, e.g. "/mqtt"
  String mqttUsername;
  String mqttPassword;
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
  out.mqttTransport = prefs.getString("transport", "tcp");
  out.mqttHost = prefs.getString("host", "");
  out.mqttPort = prefs.getUShort("port", 1883);
  out.mqttPath = prefs.getString("path", "/mqtt");
  out.mqttUsername = prefs.getString("user", "");
  out.mqttPassword = prefs.getString("mqttpass", "");
  out.printerId = prefs.getString("printer", "");
  out.commonAnode = prefs.getBool("anode", false);
  prefs.end();
  out.valid = out.wifiSsid.length() > 0 && out.mqttHost.length() > 0 && out.printerId.length() > 0;
  return out.valid;
}

void configSave(const DeviceConfig &config) {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, /*readOnly=*/false);
  prefs.putString("ssid", config.wifiSsid);
  prefs.putString("pass", config.wifiPassword);
  prefs.putString("transport", config.mqttTransport);
  prefs.putString("host", config.mqttHost);
  prefs.putUShort("port", config.mqttPort);
  prefs.putString("path", config.mqttPath);
  prefs.putString("user", config.mqttUsername);
  prefs.putString("mqttpass", config.mqttPassword);
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
  MqttConnecting,
  Connected,
};

// Called from the MQTT event handler with each printer-status payload
// (plain string: printing|idle|paused|error|offline, or "" when the retained
// status was cleared because the printer was deleted).
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
#include <mqtt_client.h>
#if __has_include("esp_crt_bundle.h")
#include "esp_crt_bundle.h"
#define STATUSLIGHT_HAVE_CRT_BUNDLE 1
#endif

static DeviceConfig s_config;
static StatusCallback s_onStatus = nullptr;
static esp_mqtt_client_handle_t s_client = nullptr;
static NetState s_state = NetState::Idle;
static uint32_t s_wifiRetryAt = 0;

static String s_brokerUri;
static String s_clientId;
static String s_statusTopic;
static String s_availabilityTopic;

// mqtt://host:port for LAN, ws(s)://host:port/mqtt through nginx — the same
// broker either way (server/statusLightBroker.js).
static String buildBrokerUri() {
  String scheme = s_config.mqttTransport;
  if (scheme != "ws" && scheme != "wss") {
    scheme = "mqtt";
  }
  String uri = scheme + "://" + s_config.mqttHost + ":" + String(s_config.mqttPort);
  if (scheme != "mqtt") {
    uri += s_config.mqttPath.startsWith("/") ? s_config.mqttPath : "/" + s_config.mqttPath;
  }
  return uri;
}

static void mqttEventHandler(void *, esp_event_base_t, int32_t eventId, void *eventData) {
  esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)eventData;
  switch ((esp_mqtt_event_id_t)eventId) {
    case MQTT_EVENT_CONNECTED:
      s_state = NetState::Connected;
      esp_mqtt_client_publish(s_client, s_availabilityTopic.c_str(), "online", 0, 0, 1);
      // Retained status arrives immediately after this subscribe.
      esp_mqtt_client_subscribe(s_client, s_statusTopic.c_str(), 0);
      break;
    case MQTT_EVENT_DISCONNECTED:
      if (s_state == NetState::Connected) {
        s_state = NetState::MqttConnecting; // esp_mqtt auto-reconnects
      }
      break;
    case MQTT_EVENT_DATA:
      if (s_onStatus && event->topic_len > 0 &&
          s_statusTopic.equals(String(event->topic, event->topic_len))) {
        String payload(event->data, event->data_len);
        s_onStatus(payload);
      }
      break;
    default:
      break;
  }
}

static void startMqtt() {
  s_brokerUri = buildBrokerUri();
  s_clientId = "statuslight-" + s_config.printerId;
  s_statusTopic = "printfarm/printers/" + s_config.printerId + "/status";
  s_availabilityTopic = "printfarm/lights/" + s_config.printerId + "/availability";

  esp_mqtt_client_config_t mqttConfig = {};
  mqttConfig.uri = s_brokerUri.c_str();
  mqttConfig.client_id = s_clientId.c_str();
  mqttConfig.username = s_config.mqttUsername.c_str();
  mqttConfig.password = s_config.mqttPassword.c_str();
  mqttConfig.keepalive = 15;
  mqttConfig.lwt_topic = s_availabilityTopic.c_str();
  mqttConfig.lwt_msg = "offline";
  mqttConfig.lwt_qos = 0;
  mqttConfig.lwt_retain = 1;
#ifdef STATUSLIGHT_HAVE_CRT_BUNDLE
  if (s_config.mqttTransport == "wss") {
    // Validate the HTTPS certificate against the built-in public-CA bundle
    // (works with Let's Encrypt etc.; a self-signed cert needs "ws" instead).
    // arduino-esp32 ships the bundle under its own symbol name.
    mqttConfig.crt_bundle_attach = arduino_esp_crt_bundle_attach;
  }
#endif

  s_client = esp_mqtt_client_init(&mqttConfig);
  esp_mqtt_client_register_event(s_client, (esp_mqtt_event_id_t)ESP_EVENT_ANY_ID, mqttEventHandler, nullptr);
  esp_mqtt_client_start(s_client);
  s_state = NetState::MqttConnecting;
}

void netBegin(const DeviceConfig &config, StatusCallback onStatus) {
  netStop();
  s_config = config;
  s_onStatus = onStatus;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(s_config.wifiSsid.c_str(), s_config.wifiPassword.c_str());
  s_state = NetState::WifiConnecting;
  s_wifiRetryAt = millis() + 20000;
}

void netStop() {
  if (s_client) {
    esp_mqtt_client_stop(s_client);
    esp_mqtt_client_destroy(s_client);
    s_client = nullptr;
  }
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
      startMqtt();
    } else if ((int32_t)(millis() - s_wifiRetryAt) >= 0) {
      // Some APs need a fresh association attempt after a long failure.
      WiFi.disconnect();
      WiFi.begin(s_config.wifiSsid.c_str(), s_config.wifiPassword.c_str());
      s_wifiRetryAt = millis() + 20000;
    }
    return;
  }
  if (!wifiUp) {
    // WiFi dropped: esp_mqtt keeps retrying on its own, but reflect the state
    // for the LED (purple breathe) until the link is back.
    s_state = NetState::WifiConnecting;
    s_wifiRetryAt = millis() + 20000;
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
    config.mqttTransport = String(doc["mqttTransport"] | "tcp");
    config.mqttHost = String(doc["mqttHost"] | "");
    config.mqttPort = (uint16_t)(doc["mqttPort"] | 1883);
    config.mqttPath = String(doc["mqttPath"] | "/mqtt");
    config.mqttUsername = String(doc["mqttUsername"] | "");
    config.mqttPassword = String(doc["mqttPassword"] | "");
    config.printerId = String(doc["printerId"] | "");
    config.commonAnode = strcmp(doc["ledPolarity"] | "common_cathode", "common_anode") == 0;
    if (config.wifiSsid.isEmpty() || config.mqttHost.isEmpty() || config.printerId.isEmpty()) {
      replyError("wifiSsid, mqttHost and printerId are required");
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
    reply["mqttHost"] = current.mqttHost;
    reply["mqttTransport"] = current.mqttTransport;
    const NetState state = netState();
    reply["net"] = state == NetState::Connected      ? "connected"
                   : state == NetState::MqttConnecting ? "mqtt-connecting"
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
// Subscribes to printfarm/printers/<printerId>/status on the dashboard's
// embedded MQTT broker (server/statusLightBroker.js) and drives a 4-pin
// analog RGB LED:
//   idle     -> solid green         printing -> solid blue
//   paused   -> solid orange        error    -> solid red
//   offline  -> blinking red (500 ms)
// Local states: unprovisioned -> white breathe; WiFi/MQTT connecting ->
// purple breathe; broker lost -> keep last color with a purple flash every
// 5 s so a dead broker is distinguishable from a healthy idle printer.

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
             (state == NetState::MqttConnecting && !s_haveStatus)) {
    ledSet(160, 0, 255, LedPattern::Breathe); // purple: connecting
  } else if (state == NetState::Connected && !s_haveStatus) {
    ledSet(255, 255, 255, LedPattern::Breathe); // connected, no status yet
  } else if (s_haveStatus) {
    // Broker lost but we have a last-known status: keep showing it, with a
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
