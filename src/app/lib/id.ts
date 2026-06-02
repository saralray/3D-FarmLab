// Generate a RFC 4122 v4 UUID.
//
// `crypto.randomUUID()` and `crypto.subtle` are only exposed in secure contexts
// (HTTPS, or http://localhost). When the app is served over a plain
// `http://<ip>:<port>` LAN address the page is a non-secure context, so
// `crypto.randomUUID` is undefined and calling it throws — which is why actions
// like "Add printer" failed when accessed by IP. `crypto.getRandomValues` is
// available even in non-secure contexts, so fall back to building the UUID from
// it, and only drop to Math.random if crypto is missing entirely.
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // Set the version (4) and variant (10xx) bits per RFC 4122.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0'));
  return (
    `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-` +
    `${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
  );
}

// Build a human-readable, URL-safe printer id from its name (e.g. "A1 MINI" ->
// "A1-MINI", "U1-01" -> "U1-01"). The id ends up in proxy/webcam/command URLs,
// some of which are not URL-encoded, so we collapse anything that isn't a letter
// or digit into a single hyphen and trim stray hyphens. `existingIds` guarantees
// uniqueness by appending -2, -3, … on collision. Falls back to a random UUID if
// the name has no usable characters (e.g. all-emoji) so an id is always produced.
export function slugifyPrinterId(name: string, existingIds: Iterable<string> = []): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!base) {
    return generateId();
  }

  const taken = new Set(existingIds);
  if (!taken.has(base)) {
    return base;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
