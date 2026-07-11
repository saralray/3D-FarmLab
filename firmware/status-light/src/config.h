#pragma once

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
