import XCTest
@testable import ClubLadder

// Port of SiteConfigTest.kt.
final class SiteConfigTests: XCTestCase {
    func test_acceptsAnHttpsUrlTrimmingSpaceAndTrailingSlashes() {
        XCTAssertEqual("https://site.example.invalid", SiteConfig.read(" https://site.example.invalid// "))
    }

    func test_acceptsAnUpperCaseSchemeAsTheSupabaseUrlDoes() {
        XCTAssertEqual("HTTPS://site.example.invalid", SiteConfig.read("HTTPS://site.example.invalid"))
    }

    func test_readsAMissingOrBlankValueAsNoWebsiteNotAnError() {
        XCTAssertNil(SiteConfig.read(nil))
        XCTAssertNil(SiteConfig.read(""))
        XCTAssertNil(SiteConfig.read("   "))
    }

    func test_refusesPlainHttpWhichWouldCarryTheSessionTokensInTheClear() {
        XCTAssertNil(SiteConfig.read("http://site.example.invalid"))
    }

    // iOS only: the bare "https://" an empty site address leaves is no website, not an error.
    func test_readsTheBareSchemeAnEmptyAddressLeavesAsNoWebsite() {
        XCTAssertNil(SiteConfig.read("https://"))
        XCTAssertNil(SiteConfig.read(" https:// "))
    }
}
