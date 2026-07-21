#include "config.h"

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
