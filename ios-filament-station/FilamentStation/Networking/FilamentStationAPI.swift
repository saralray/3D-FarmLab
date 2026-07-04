import Foundation

enum APIError: LocalizedError {
    case notConfigured
    case http(status: Int, message: String)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Server URL and API key aren't set up yet."
        case .http(let status, let message):
            return "Request failed (\(status)): \(message)"
        case .decoding(let error):
            return "Couldn't parse server response: \(error.localizedDescription)"
        }
    }
}

/// Talks to the API-key-gated /api/v1/filament-station/* surface — the same
/// route handler (handleFilamentStation in server/filamentStation.js) the
/// Android web page's cookie-session /api/filament-station/* hits, just a
/// different front door. No session to reuse from a native app, so this
/// authenticates like any other automation client: X-Api-Key header, a key
/// minted in 3D-FarmLab Settings → Slicer Keys with printfarm_manage scope.
final class FilamentStationAPI {
    static let shared = FilamentStationAPI()

    private let session = URLSession(configuration: .default)
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        return decoder
    }()

    private var baseURL: URL? {
        guard let raw = KeychainStore.read(forKey: "backend_url"), let url = URL(string: raw) else { return nil }
        return url.appendingPathComponent("api/v1/filament-station")
    }

    private var apiKey: String? {
        KeychainStore.read(forKey: "api_key")
    }

    var isConfigured: Bool {
        baseURL != nil && apiKey != nil
    }

    func configure(backendURL: String, apiKey: String) {
        KeychainStore.save(backendURL, forKey: "backend_url")
        KeychainStore.save(apiKey, forKey: "api_key")
    }

    private func request(path: String, method: String = "GET", body: Data? = nil) throws -> URLRequest {
        guard let baseURL, let apiKey else { throw APIError.notConfigured }
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue(apiKey, forHTTPHeaderField: "X-Api-Key")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.http(status: 0, message: "No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
                ?? String(data: data, encoding: .utf8)
                ?? "Unknown error"
            throw APIError.http(status: http.statusCode, message: message)
        }
        return data
    }

    // MARK: - Spools

    func listSpools() async throws -> [FilamentSpool] {
        let data = try await send(try request(path: "spools"))
        do {
            return try decoder.decode([FilamentSpool].self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// Raw JSON bytes for the OpenSpool payload — written verbatim as the
    /// NDEF "mime" record's payload, not decoded into a Swift model. The
    /// server (buildOpenSpoolPayload in server/openspoolTag.js) is the single
    /// source of truth for the tag's contents; the app just relays bytes.
    func openSpoolPayload(spoolId: String) async throws -> Data {
        try await send(try request(path: "spools/\(spoolId)/openspool-payload"))
    }

    // MARK: - NFC

    func reportTagScanned(tagUid: String, trayUuid: String? = nil) async throws -> TagScanResult {
        var body: [String: String] = ["tag_uid": tagUid]
        if let trayUuid { body["tray_uuid"] = trayUuid }
        let data = try JSONSerialization.data(withJSONObject: body)
        let responseData = try await send(try request(path: "nfc/tag-scanned", method: "POST", body: data))
        do {
            return try decoder.decode(TagScanResult.self, from: responseData)
        } catch {
            throw APIError.decoding(error)
        }
    }

    func linkTag(spoolId: String, tagUid: String) async throws {
        let body = ["spool_id": spoolId, "tag_uid": tagUid]
        let data = try JSONSerialization.data(withJSONObject: body)
        _ = try await send(try request(path: "nfc/link-tag", method: "POST", body: data))
    }
}
