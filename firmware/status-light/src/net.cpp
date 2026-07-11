#include "net.h"

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
