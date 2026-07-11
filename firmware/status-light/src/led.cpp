#include "led.h"

#include <Arduino.h>

// GPIO3/4/5: plain IOs on the C3 Super Mini — deliberately not the strapping
// pins (GPIO2/8/9) so the LED wiring can never disturb boot, and not the
// onboard LED (GPIO8).
static const int PIN_R = 3;
static const int PIN_G = 4;
static const int PIN_B = 5;

static const int CH_R = 0;
static const int CH_G = 1;
static const int CH_B = 2;

static const int PWM_FREQ_HZ = 5000;
static const int PWM_RES_BITS = 8;

static bool s_commonAnode = false;
static uint8_t s_r = 0, s_g = 0, s_b = 0;
static LedPattern s_pattern = LedPattern::Off;

static void writeRgb(uint8_t r, uint8_t g, uint8_t b) {
  // Common anode sinks current through the pins, so the duty is inverted.
  ledcWrite(CH_R, s_commonAnode ? 255 - r : r);
  ledcWrite(CH_G, s_commonAnode ? 255 - g : g);
  ledcWrite(CH_B, s_commonAnode ? 255 - b : b);
}

void ledInit(bool commonAnode) {
  s_commonAnode = commonAnode;
  ledcSetup(CH_R, PWM_FREQ_HZ, PWM_RES_BITS);
  ledcSetup(CH_G, PWM_FREQ_HZ, PWM_RES_BITS);
  ledcSetup(CH_B, PWM_FREQ_HZ, PWM_RES_BITS);
  ledcAttachPin(PIN_R, CH_R);
  ledcAttachPin(PIN_G, CH_G);
  ledcAttachPin(PIN_B, CH_B);
  writeRgb(0, 0, 0);
}

void ledSetPolarity(bool commonAnode) {
  s_commonAnode = commonAnode;
}

void ledSet(uint8_t r, uint8_t g, uint8_t b, LedPattern pattern) {
  s_r = r;
  s_g = g;
  s_b = b;
  s_pattern = pattern;
}

void ledTick() {
  const uint32_t now = millis();
  switch (s_pattern) {
    case LedPattern::Off:
      writeRgb(0, 0, 0);
      break;
    case LedPattern::Solid:
      writeRgb(s_r, s_g, s_b);
      break;
    case LedPattern::Blink: {
      const bool on = (now / 500) % 2 == 0;
      writeRgb(on ? s_r : 0, on ? s_g : 0, on ? s_b : 0);
      break;
    }
    case LedPattern::Breathe: {
      // Triangle wave over ~2 s, scaled 10–100 % so it never fully disappears.
      const uint32_t phase = now % 2000;
      const uint32_t tri = phase < 1000 ? phase : 2000 - phase; // 0..1000
      const uint32_t level = 25 + (tri * 230) / 1000;           // 25..255
      writeRgb((uint16_t)s_r * level / 255, (uint16_t)s_g * level / 255,
               (uint16_t)s_b * level / 255);
      break;
    }
  }
}
