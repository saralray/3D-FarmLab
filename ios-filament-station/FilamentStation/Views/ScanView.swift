import SwiftUI

/// Scan a tag to identify which spool it belongs to — mirrors the Android
/// page's "Scan to identify" mode.
struct ScanView: View {
    private let nfc = NFCService()

    @State private var status = "Tap Scan, then hold your iPhone near a tag."
    @State private var matchedSpool: FilamentSpool?
    @State private var noMatch = false

    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                Text(status)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)

                if let matchedSpool {
                    VStack {
                        Circle()
                            .fill(Color(hex: matchedSpool.hexColor))
                            .frame(width: 40, height: 40)
                            .overlay(Circle().stroke(.secondary, lineWidth: 0.5))
                        Text(matchedSpool.displayName).font(.headline)
                    }
                } else if noMatch {
                    Text("No spool matched this tag.").foregroundStyle(.orange)
                }

                Button("Scan") { scan() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!NFCService.isAvailable)

                if !NFCService.isAvailable {
                    Text("NFC isn't available on this device.").font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle("Scan")
        }
    }

    private func scan() {
        matchedSpool = nil
        noMatch = false
        status = "Hold your iPhone near a tag…"
        nfc.readTagIdentifier { result in
            switch result {
            case .success(let tagUid):
                status = "Tag detected: \(tagUid)"
                Task {
                    do {
                        let scanResult = try await FilamentStationAPI.shared.reportTagScanned(tagUid: tagUid)
                        if scanResult.matched, let spoolId = scanResult.spoolId {
                            let all = try await FilamentStationAPI.shared.listSpools()
                            matchedSpool = all.first { $0.id == spoolId }
                            noMatch = matchedSpool == nil
                        } else {
                            noMatch = true
                        }
                    } catch {
                        status = error.localizedDescription
                    }
                }
            case .failure(let error):
                status = error.localizedDescription ?? "Scan failed"
            }
        }
    }
}
