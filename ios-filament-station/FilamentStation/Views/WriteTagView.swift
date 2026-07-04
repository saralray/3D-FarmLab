import SwiftUI

/// Pick a spool, fetch its OpenSpool payload, write it to a tapped tag, then
/// link the tag's identifier back to the spool — mirrors the Android page's
/// "Write a tag" mode.
struct WriteTagView: View {
    private let nfc = NFCService()

    @State private var spools: [FilamentSpool] = []
    @State private var selectedSpool: FilamentSpool?
    @State private var status = ""
    @State private var loading = false

    var body: some View {
        NavigationView {
            Form {
                Section("Spool") {
                    Picker("Spool", selection: $selectedSpool) {
                        Text("Select a spool").tag(FilamentSpool?.none)
                        ForEach(spools) { spool in
                            Text(spool.displayName).tag(Optional(spool))
                        }
                    }
                }
                Section {
                    Button(loading ? "Writing…" : "Write tag") { write() }
                        .disabled(selectedSpool == nil || loading || !NFCService.isAvailable)
                    if !status.isEmpty {
                        Text(status).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Write Tag")
            .task { await loadSpools() }
        }
    }

    private func loadSpools() async {
        do {
            spools = try await FilamentStationAPI.shared.listSpools()
        } catch {
            status = error.localizedDescription
        }
    }

    private func write() {
        guard let spool = selectedSpool else { return }
        loading = true
        status = "Fetching tag payload…"

        Task {
            do {
                let payload = try await FilamentStationAPI.shared.openSpoolPayload(spoolId: spool.id)
                status = "Hold your iPhone near the tag…"

                nfc.writeOpenSpoolPayload(payload) { result in
                    Task {
                        switch result {
                        case .success(let tagUid):
                            do {
                                try await FilamentStationAPI.shared.linkTag(spoolId: spool.id, tagUid: tagUid)
                                status = "Tag written and linked to \(spool.displayName)."
                            } catch {
                                status = "Written, but linking failed: \(error.localizedDescription)"
                            }
                        case .failure(let error):
                            status = error.localizedDescription ?? "Write failed"
                        }
                        loading = false
                    }
                }
            } catch {
                status = error.localizedDescription
                loading = false
            }
        }
    }
}
