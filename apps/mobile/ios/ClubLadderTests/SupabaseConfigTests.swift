import XCTest
@testable import ClubLadder

// Port of SupabaseConfigTest.kt, which mirrors the Expo app's config.test.ts.
final class SupabaseConfigTests: XCTestCase {
    private let url = SupabaseConfig.urlName
    private let key = SupabaseConfig.anonKeyName

    func test_acceptsAnHttpsUrlAndAKeyTrimmingATrailingSlash() {
        XCTAssertEqual(.ok(url: "https://db.example.invalid", anonKey: "k"), SupabaseConfig.read(url: " https://db.example.invalid/ ", anonKey: "k"))
    }

    func test_keepsAPathPrefix() {
        XCTAssertEqual(.ok(url: "https://example.invalid/supabase", anonKey: "k"), SupabaseConfig.read(url: "https://example.invalid/supabase", anonKey: "k"))
    }

    func test_namesBothValuesWhenBothAreMissing() {
        XCTAssertEqual(.missing([url, key]), SupabaseConfig.read(url: nil, anonKey: nil))
        XCTAssertEqual(.missing([url, key]), SupabaseConfig.read(url: "", anonKey: ""))
    }

    func test_refusesPlainHttpWhichWouldCarryTheSessionTokensInTheClear() {
        XCTAssertEqual(.missing([url]), SupabaseConfig.read(url: "http://example.invalid", anonKey: "k"))
    }

    func test_treatsABlankKeyAsMissing() {
        XCTAssertEqual(.missing([key]), SupabaseConfig.read(url: "https://example.invalid", anonKey: "   "))
    }

    func test_acceptsAnUpperCaseSchemeAsTheJsRegexsIFlagDoes() {
        XCTAssertEqual(.ok(url: "HTTPS://example.invalid", anonKey: "k"), SupabaseConfig.read(url: "HTTPS://example.invalid", anonKey: "k"))
    }

    // iOS only: an empty address in Local.xcconfig reaches Info.plist as a bare "https://".
    func test_readsTheBareSchemeAnEmptyAddressLeavesAsMissing() {
        XCTAssertEqual(.missing([url]), SupabaseConfig.read(url: "https://", anonKey: "k"))
    }
}
