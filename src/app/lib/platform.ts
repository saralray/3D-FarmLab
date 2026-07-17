// Platform detection helpers for tuning browser-specific UI behavior.

// iPadOS/iOS Safari greys out *every* file in its picker when an
// <input type="file"> carries an `accept` list of extensions it can't map to a
// known UTI — and 3D model extensions like .stl/.3mf/.obj have no registered
// type — which makes such upload forms impossible to complete on an iPad.
// Callers use this to drop the `accept` hint on iOS while keeping it elsewhere;
// the extension whitelist is still enforced in JS on submit, so nothing is lost.
//
// iPadOS 13+ reports a desktop ("MacIntel") user-agent, so we additionally
// treat a touch-capable Mac as iOS.
export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}
