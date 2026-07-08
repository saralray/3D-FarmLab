// A literal wound-filament spool silhouette, tinted by the loaded material's
// color. Originally lived inline in PrinterDetail's AMS slot display; pulled
// out here so the Filament Station page (inventory, assignments, NFC scan
// result) can use the same physical-spool motif instead of a generic color
// dot. The reel-body browns are the cardboard/plastic of a real spool, not
// theme tokens — they don't change with material color or light/dark mode.
export function FilamentSpoolIcon({ color, scale = 1 }: { color: string; scale?: number }) {
  return (
    <svg
      viewBox="0 0 256 500"
      width={28 * scale}
      height={40 * scale}
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M202.1.3h-5v2.3C179 19 165 123.6 165 250s14 231.1 32.2 247.5v2.3h5c20.5 0 37.2-111.9 37.2-249.8S222.7.3 202.1.3"
        fill="#9b7242"
      />
      <path
        d="M197.1.3c20.5 0 37.2 111.9 37.2 249.8s-16.7 249.8-37.2 249.8S160 387.9 160 250 176.6.3 197.1.3"
        fill="#c08f4f"
      />
      <path
        d="m194.6 166.9-145.5.1c6.9 0 12.4 37.2 12.4 83.2 0 44.1-5.1 80.3-11.6 83h144.7c6.9 0 12.4-37.2 12.4-83.2 0-45.8-5.6-83.1-12.4-83.1"
        fill="#594226"
      />
      <path
        d="M35 31c18.8-12.1 138-10.4 162.1 0 24.9 10.4 41.1 398.9 0 438.1-37.2 12.2-147.7 11.4-162.1 0C22 458.8 16.2 43 35 31"
        fill={color}
      />
      <path
        d="M42.5.3h-5v2.3C19.3 19 5.3 123.6 5.3 250s14 231.1 32.2 247.5v2.3h5c20.5 0 37.2-111.9 37.2-249.8S63 .3 42.5.3"
        fill="#9b7242"
      />
      <path
        d="M37.5.3C58 .3 74.6 112.2 74.6 250S58 499.8 37.5 499.8.3 387.9.3 250 16.9.3 37.5.3"
        fill="#c08f4f"
      />
      <path
        d="M35.5 171.6c6.5 0 11.6 35.1 11.6 78.4s-5.3 78.4-11.6 78.4-11.6-35.1-11.6-78.4 5.1-78.4 11.6-78.4"
        fill="#231a0f"
      />
    </svg>
  );
}
