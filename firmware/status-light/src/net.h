#pragma once

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
