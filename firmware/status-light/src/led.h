#pragma once

#include <stdint.h>

// 4-pin analog RGB LED on three LEDC PWM channels. Patterns are non-blocking;
// call ledTick() from loop().
enum class LedPattern : uint8_t {
  Off,
  Solid,
  Blink,    // 500 ms on / 500 ms off (offline = blinking red)
  Breathe,  // slow sine-ish fade (connecting states)
};

void ledInit(bool commonAnode);
void ledSetPolarity(bool commonAnode);
void ledSet(uint8_t r, uint8_t g, uint8_t b, LedPattern pattern);
void ledTick();
