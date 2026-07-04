import CoreNFC

enum NFCServiceError: LocalizedError {
    case unavailable
    case noTagDetected
    case notNDEFCapable
    case notWritable
    case underlying(Error)

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "NFC isn't available on this device."
        case .noTagDetected:
            return "No tag detected — try again."
        case .notNDEFCapable:
            return "This tag isn't NDEF-formatted (or formattable)."
        case .notWritable:
            return "This tag is read-only."
        case .underlying(let error):
            return error.localizedDescription
        }
    }
}

/// Wraps NFCNDEFReaderSession for both reading (identify a tag's UID, same
/// role as Android's NDEFReader.scan()) and writing (push the OpenSpool JSON
/// payload, same role as NDEFReader.write()). One-shot per call, matching the
/// Android page's "tap once per action" flow rather than a continuous scan.
///
/// NEEDS REAL-DEVICE VERIFICATION: this follows Apple's documented
/// queryNDEFStatus → writeNDEF pattern, but exact session-invalidation
/// timing and multi-tag-in-field behavior varies across hardware/iOS
/// versions and can't be checked without a physical iPhone.
final class NFCService: NSObject, NFCNDEFReaderSessionDelegate {
    static var isAvailable: Bool {
        NFCNDEFReaderSession.readingAvailable
    }

    private var session: NFCNDEFReaderSession?
    private var pendingWritePayload: Data?
    private var readCompletion: ((Result<String, NFCServiceError>) -> Void)?
    private var writeCompletion: ((Result<String, NFCServiceError>) -> Void)?

    /// Scans for a tag and returns its identifier (hex string, colon-stripped
    /// and uppercased — same normalization the Android page applies to
    /// NDEFReader's serialNumber) without writing anything.
    func readTagIdentifier(completion: @escaping (Result<String, NFCServiceError>) -> Void) {
        guard Self.isAvailable else {
            completion(.failure(.unavailable))
            return
        }
        readCompletion = completion
        writeCompletion = nil
        pendingWritePayload = nil
        session = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: true)
        session?.alertMessage = "Hold your iPhone near the tag."
        session?.begin()
    }

    /// Scans for a tag and writes the given JSON payload to it as a single
    /// NDEF "mime" record (application/json) — mirrors the Android page's
    /// records: [{recordType: 'mime', mediaType: 'application/json', ...}].
    /// Returns the tag's identifier on success so the caller can link it.
    func writeOpenSpoolPayload(_ payload: Data, completion: @escaping (Result<String, NFCServiceError>) -> Void) {
        guard Self.isAvailable else {
            completion(.failure(.unavailable))
            return
        }
        writeCompletion = completion
        readCompletion = nil
        pendingWritePayload = payload
        // invalidateAfterFirstRead=false: we need the session to stay open
        // across queryNDEFStatus + writeNDEF, not just the initial detect.
        session = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: false)
        session?.alertMessage = "Hold your iPhone near the tag to write."
        session?.begin()
    }

    // MARK: - NFCNDEFReaderSessionDelegate

    func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {
        // Read-only path (invalidateAfterFirstRead=true) ends here; the
        // identifier itself comes from didDetect tags: below, which the
        // session also calls when reader-mode reports raw tags. This
        // delegate method exists to satisfy the protocol requirement when
        // an NDEF message (rather than a raw tag) is what gets reported.
    }

    func readerSession(_ session: NFCNDEFReaderSession, didDetect tags: [NFCNDEFTag]) {
        guard let tag = tags.first else {
            fail(.noTagDetected)
            return
        }

        session.connect(to: tag) { [weak self] error in
            guard let self else { return }
            if let error {
                self.fail(.underlying(error))
                return
            }

            let identifier = Self.identifierString(for: tag)

            guard let payload = self.pendingWritePayload else {
                // Read-only flow: identifier is all we need.
                session.alertMessage = "Tag read."
                session.invalidate()
                let completion = self.readCompletion
                self.readCompletion = nil
                completion?(.success(identifier))
                return
            }

            tag.queryNDEFStatus { status, _, error in
                if let error {
                    self.fail(.underlying(error))
                    return
                }
                guard status == .readWrite else {
                    self.fail(.notWritable)
                    return
                }

                let record = NFCNDEFPayload(
                    format: .media,
                    type: "application/json".data(using: .utf8)!,
                    identifier: Data(),
                    payload: payload
                )
                let message = NFCNDEFMessage(records: [record])

                tag.writeNDEF(message) { error in
                    if let error {
                        self.fail(.underlying(error))
                        return
                    }
                    session.alertMessage = "Tag written."
                    session.invalidate()
                    let completion = self.writeCompletion
                    self.writeCompletion = nil
                    completion?(.success(identifier))
                }
            }
        }
    }

    func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
        // A clean invalidate() call after success already resolved the
        // completion handler above; only report an error here if neither
        // completion has fired yet (i.e. this is a genuine failure/timeout/
        // user-cancel, not the deliberate invalidate after success).
        if readCompletion != nil || writeCompletion != nil {
            fail(.underlying(error))
        }
    }

    // MARK: - Helpers

    private func fail(_ error: NFCServiceError) {
        session?.alertMessage = error.errorDescription ?? "NFC error"
        session?.invalidate()
        readCompletion?(.failure(error))
        writeCompletion?(.failure(error))
        readCompletion = nil
        writeCompletion = nil
    }

    private static func identifierString(for tag: NFCNDEFTag) -> String {
        // NFCNDEFTag doesn't expose a raw identifier directly; the
        // underlying MiFare/FeliCa/ISO7816 tag types do. This mirrors
        // Android's NDEFReader.serialNumber as closely as Core NFC allows —
        // VERIFY against real hardware, the exact cast needed depends on
        // which tag technology is presented (NTAG213/215/216 show up as
        // .miFare on iOS).
        if case let .miFare(mifareTag) = tag {
            return mifareTag.identifier.map { String(format: "%02X", $0) }.joined()
        }
        return "UNKNOWN"
    }
}
