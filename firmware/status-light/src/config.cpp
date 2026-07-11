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
