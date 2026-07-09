# Filament Station — iOS (Core NFC)

Companion app for scanning/writing OpenSpool NFC tags on iPhone, since Safari
has no Web NFC support (and shows no signal of adding it) — this is the only
way to get NFC write access to a physical spool tag from an iPhone. It talks
to the same 3D-FarmLab backend the Android web page (`/filament-station` in
the main app) uses, but over the API-key-gated `/api/v1/filament-station/*`
surface instead of a browser session (there's no cookie to reuse from a
native app).

**This is a source scaffold, not a buildable/tested project** — it was
written in a Linux environment with no Xcode, no macOS, and no physical
iPhone. Someone with a Mac needs to:

1. Create a new Xcode project: File → New → Project → iOS → App, product
   name `FilamentStation`, interface **SwiftUI**, language **Swift**.
2. Drag the `FilamentStation/` folder's contents into the project (uncheck
   "Copy items if needed" is fine either way; just make sure they're added
   to the app target).
3. **Capabilities** (Signing & Capabilities tab): add **Near Field
   Communication Tag Reading**. This requires a paid Apple Developer account
   — it provisions the `com.apple.developer.nfc.readersession.formats`
   entitlement, which free accounts can't get.
4. **Info.plist**: add `NFCReaderUsageDescription` (a user-facing string
   explaining why the app wants NFC — e.g. "Used to scan and write filament
   spool tags."). See `Support/Info.plist.additions.xml` for the exact keys.
5. Build to a **physical iPhone** (7 or later, iOS 13+) — the Simulator has
   no NFC radio, `NFCNDEFReaderSession` sessions fail immediately there.
6. First launch: the Setup screen asks for the 3D-FarmLab server URL and an
   API key. Create the key in **3D-FarmLab → Settings → Slicer Keys** with
   the `printfarm_manage` permission scope, same as any other automation
   client. Stored in the Keychain (`Support/KeychainStore.swift`), not
   `UserDefaults` — it's a credential.

## Screens

- **Setup** — one-time server URL + API key entry.
- **Spool list** — `GET /api/v1/filament-station/spools`, mirrors the
  Android page's inventory tab (read-only here; add/edit spools from the
  web app).
- **Scan** — starts an `NFCNDEFReaderSession`, on tag detect reads the tag's
  identifier, POSTs `/api/v1/filament-station/nfc/tag-scanned`, shows the
  matched spool or "unknown tag".
- **Write** — pick a spool from the list, fetch its
  `GET /api/v1/filament-station/spools/:id/openspool-payload`, start a
  write-capable `NFCNDEFReaderSession`, write an NDEF `application/json`
  record with that payload, then POST
  `/api/v1/filament-station/nfc/link-tag` with the tag's identifier.

## What needs real-device verification (can't be checked here)

- Exact `NFCNDEFTag.queryNDEFStatus`/`writeNDEF` sequencing and error
  handling on real hardware — the code follows Apple's documented pattern
  but Core NFC's behavior around session invalidation and multi-tag
  detection varies across iPhone models/iOS versions.
- Tag compatibility: the OpenSpool payload includes brand/subtype when the
  spool record has them (temps/diameter/weight/alpha are intentionally
  omitted to keep the payload minimal), matching the Snapmaker U1 Extended
  Firmware's documented schema (needed for Snapmaker Orca's
  `<brand> <type> <subtype>` naming and for OpenRFID mode to not hide the
  spool as an unrecognized vendor). That firmware's own docs recommend
  NTAG215 (540 bytes usable) as the target tag for the U1, not NTAG213
  (~144 bytes) — write-lock behavior should still be spot-checked on real
  hardware, but capacity shouldn't be an issue on NTAG215/216.
- Entitlement/provisioning profile setup end-to-end (needs a paid account).
