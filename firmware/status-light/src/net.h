#pragma once

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
