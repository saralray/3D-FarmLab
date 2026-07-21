// ESP32-C3 Super Mini per-printer status light for STEM Lab Print Farm.
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
