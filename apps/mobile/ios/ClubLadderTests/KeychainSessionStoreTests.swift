import Security
import XCTest
@testable import ClubLadder

// In place of FileSessionStoreTest.kt: the Keychain is the encryption, so the
// cipher cases become "an item that is not a session". A distinct service per
// run keeps the app's own session item untouched.
final class KeychainSessionStoreTests: XCTestCase {
    private var store: KeychainSessionStore!
    private var service = ""
    private let session = StoredSession(accessToken: "access", refreshToken: "refresh", expiresAtEpochSec: 1_800_000_000, userId: "user-1", email: "member@example.invalid")

    override func setUpWithError() throws {
        service = "com.clubladder.app.tests.\(UUID().uuidString)"
        store = KeychainSessionStore(service: service)
        // A missing keychain entitlement is a broken test host, never a pass.
        do {
            try store.write(session)
            store.clear()
        } catch let error as KeychainError where error.status == errSecMissingEntitlement {
            throw XCTSkip("The test host has no keychain access (-34018)")
        }
    }

    override func tearDown() {
        store?.clear()
        store = nil
    }

    func test_roundTripsASessionThroughTheKeychain() throws {
        try store.write(session)
        XCTAssertEqual(session, store.read())
        let noEmail = StoredSession(accessToken: "a2", refreshToken: "r2", expiresAtEpochSec: 1, userId: "u2")
        try store.write(noEmail)
        XCTAssertEqual(noEmail, store.read())
    }

    func test_readsNoItemAsSignedOut() {
        XCTAssertNil(store.read())
    }

    func test_deletesACorruptedItemAndReadsItAsSignedOut() throws {
        try store.writeRaw(Data([0xFF, 0xFE, 0x00, 0x7B]))
        XCTAssertNil(store.read())
        XCTAssertFalse(itemExists())
    }

    func test_deletesAnItemThatIsNotASession() throws {
        try store.writeRaw(Data(#"{"accessToken":"a","refreshToken":"r"}"#.utf8))
        XCTAssertNil(store.read())
        XCTAssertFalse(itemExists())
    }

    func test_clearsTheSession() throws {
        try store.write(session)
        XCTAssertTrue(itemExists())
        store.clear()
        XCTAssertNil(store.read())
        XCTAssertFalse(itemExists())
    }

    func test_clearsAStaleSessionOnTheFirstLaunchOfAnInstallOnly() throws {
        let suite = "com.clubladder.app.tests.defaults.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try store.write(session)
        store.clearIfFirstLaunch(defaults: defaults)
        XCTAssertNil(store.read())
        try store.write(session)
        store.clearIfFirstLaunch(defaults: defaults)
        XCTAssertEqual(session, store.read())
    }

    private func itemExists() -> Bool {
        // read() deletes an unreadable item, so presence is asked of the Keychain directly.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session",
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }
}
