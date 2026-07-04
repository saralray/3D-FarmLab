import Foundation

/// Mirrors filamentSpoolRowToJs in server/postgres.js. GET responses use
/// camelCase keys as-is (the server does NOT convert to snake_case on the
/// way out, only on the way in for POST/PUT bodies — see CreateSpoolRequest)
/// so Swift's default synthesized Codable already matches 1:1, no CodingKeys
/// needed here.
struct FilamentSpool: Codable, Identifiable, Hashable {
    let id: String
    let material: String
    let subtype: String?
    let colorName: String?
    let rgba: String
    let brand: String?
    let labelWeight: Double
    let coreWeight: Double
    let weightUsed: Double
    let nozzleTempMin: Int?
    let nozzleTempMax: Int?
    let tagUid: String?
    let trayUuid: String?
    let dataOrigin: String?
    let archived: Bool
    let createdAt: String

    var displayName: String {
        var parts = [material]
        if let subtype, !subtype.isEmpty { parts.append(subtype) }
        var name = parts.joined(separator: " ")
        if let colorName, !colorName.isEmpty {
            name += " — \(colorName)"
        }
        return name
    }

    var hexColor: String {
        let hex = rgba.isEmpty ? "FFFFFFFF" : rgba
        return "#" + hex.prefix(6)
    }
}

/// POST /api/v1/filament-station/nfc/tag-scanned response shape.
struct TagScanResult: Codable {
    let matched: Bool
    let spoolId: String?

    enum CodingKeys: String, CodingKey {
        case matched
        case spoolId = "spool_id"
    }
}
