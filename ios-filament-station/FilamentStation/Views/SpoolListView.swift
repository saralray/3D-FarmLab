import SwiftUI

/// Read-only inventory list — add/edit spools from the main 3D-FarmLab web
/// app (this app's job is scanning/writing tags, not full spool CRUD).
struct SpoolListView: View {
    let onReset: () -> Void

    @State private var spools: [FilamentSpool] = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationView {
            List {
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                ForEach(spools) { spool in
                    HStack {
                        Circle()
                            .fill(Color(hex: spool.hexColor))
                            .frame(width: 16, height: 16)
                            .overlay(Circle().stroke(.secondary, lineWidth: 0.5))
                        VStack(alignment: .leading) {
                            Text(spool.displayName)
                            if let brand = spool.brand {
                                Text(brand).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if spool.tagUid != nil || spool.trayUuid != nil {
                            Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
                        }
                    }
                }
            }
            .navigationTitle("Spools")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Sign out", role: .destructive) {
                        KeychainStore.delete(forKey: "backend_url")
                        KeychainStore.delete(forKey: "api_key")
                        onReset()
                    }
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            spools = try await FilamentStationAPI.shared.listSpools()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&value)
        let r = Double((value >> 16) & 0xFF) / 255
        let g = Double((value >> 8) & 0xFF) / 255
        let b = Double(value & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}
