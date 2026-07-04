import SwiftUI

/// One-time setup: server URL + API key. Create the key in 3D-FarmLab under
/// Settings → Slicer Keys with the printfarm_manage scope (same requirement
/// the old Pi daemon had, just entered here instead of an env var).
struct SetupView: View {
    let onConfigured: () -> Void

    @State private var backendURL = "https://"
    @State private var apiKey = ""
    @State private var error: String?

    var body: some View {
        NavigationView {
            Form {
                Section {
                    Text("Enter your 3D-FarmLab server address and an API key with the printfarm_manage scope (Settings → Slicer Keys).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("Server") {
                    TextField("https://farm.example.com", text: $backendURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("API key") {
                    SecureField("Paste API key", text: $apiKey)
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
                Section {
                    Button("Save") { save() }
                        .disabled(backendURL.isEmpty || apiKey.isEmpty)
                }
            }
            .navigationTitle("Filament Station Setup")
        }
    }

    private func save() {
        guard URL(string: backendURL) != nil else {
            error = "That doesn't look like a valid URL."
            return
        }
        FilamentStationAPI.shared.configure(backendURL: backendURL, apiKey: apiKey)
        onConfigured()
    }
}
