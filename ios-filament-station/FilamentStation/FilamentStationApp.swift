import SwiftUI

@main
struct FilamentStationApp: App {
    @State private var isConfigured = FilamentStationAPI.shared.isConfigured

    var body: some Scene {
        WindowGroup {
            if isConfigured {
                RootTabView(onReset: { isConfigured = false })
            } else {
                SetupView(onConfigured: { isConfigured = true })
            }
        }
    }
}

struct RootTabView: View {
    let onReset: () -> Void

    var body: some View {
        TabView {
            ScanView()
                .tabItem { Label("Scan", systemImage: "wave.3.right") }
            WriteTagView()
                .tabItem { Label("Write", systemImage: "square.and.pencil") }
            SpoolListView(onReset: onReset)
                .tabItem { Label("Spools", systemImage: "shippingbox") }
        }
    }
}
