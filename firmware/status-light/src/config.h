#pragma once

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
