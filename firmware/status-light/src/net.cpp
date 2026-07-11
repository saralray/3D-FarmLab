#include "net.h"

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
// arduino-embed symbol `_binary_data_cert_..._bin_start` isn't produced in a
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
