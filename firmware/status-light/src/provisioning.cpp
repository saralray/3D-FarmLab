#include "provisioning.h"

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
    if (c == '\n' || c == '\r') {
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
