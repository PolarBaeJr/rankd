import Foundation
import Security

struct KeychainError: Error, Equatable {
    let status: OSStatus
}

/// One generic-password Keychain item, readable after the first unlock and
/// never synced or migrated to another device. Anything that cannot be read
/// back as a session (a torn write from an older build, a value that is not a
/// session) is deleted and read as signed out: the member signs in again,
/// rather than the app failing on every launch.
final class KeychainSessionStore: SessionStore {
    private let service: String
    private let account = "session"

    init(service: String = "com.clubladder.app.session") {
        self.service = service
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    func read() -> StoredSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        guard let data = result as? Data,
              let text = String(data: data, encoding: .utf8),
              let json = JSONValue.parse(text),
              let session = StoredSession(json: json) else {
            clear()
            return nil
        }
        return session
    }

    func write(_ session: StoredSession) throws {
        let data = Data(session.json.serialized.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainError(status: status) }
        var add = baseQuery
        for (key, value) in attributes { add[key] = value }
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError(status: added) }
    }

    func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    /// Raw bytes under the session item, for tests of an unreadable value.
    func writeRaw(_ data: Data) throws {
        clear()
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    /// The Keychain outlives an uninstall, so a reinstall would wake up signed
    /// in with a session the member thinks they removed. The first launch of an
    /// install clears it; UserDefaults does not survive the uninstall.
    func clearIfFirstLaunch(defaults: UserDefaults = .standard) {
        let key = "didLaunch"
        if defaults.bool(forKey: key) { return }
        clear()
        defaults.set(true, forKey: key)
    }
}
