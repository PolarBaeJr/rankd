import XCTest
@testable import ClubLadder

// Port of FeaturesTest.kt (the parseFeatureFlags and featureGate cases of features.test.ts).
final class FeaturesTests: XCTestCase {
    private func row(_ field: String, _ value: JSONValue) -> JSONValue { .object([(field, value)]) }
    private let malformed: [JSONValue] = [.string("false"), .int(0), .null, .string("no"), .array([]), .object([])]

    func test_hasGuestWaiversOffAndEveryOtherFeatureOn() {
        XCTAssertEqual(false, defaultFeatureFlags["guest_waivers"])
        for f in features where f.id != "guest_waivers" { XCTAssertEqual(true, defaultFeatureFlags[f.id], f.id) }
    }

    func test_readsAnAbsentRowAsEveryFeatureAtItsDefault() {
        XCTAssertEqual(defaultFeatureFlags, parseFeatureFlags(nil))
        XCTAssertEqual(defaultFeatureFlags, parseFeatureFlags(.null))
        XCTAssertEqual(defaultFeatureFlags, parseFeatureFlags(.object([])))
    }

    func test_switchesOffOnlyTheFeatureStoredAsAnExplicitFalse() {
        let flags = parseFeatureFlags(row("tournaments_enabled", .bool(false)))
        XCTAssertEqual(false, flags["tournaments"])
        for f in features where f.id != "tournaments" { XCTAssertEqual(defaultFeatureFlags[f.id], flags[f.id], f.id) }
    }

    func test_readsAnythingMalformedAsOn() {
        for value in malformed { XCTAssertEqual(true, parseFeatureFlags(row("tournaments_enabled", value))["tournaments"], value.serialized) }
        XCTAssertEqual(defaultFeatureFlags, parseFeatureFlags(.string("tournaments_enabled=false")))
        XCTAssertEqual(defaultFeatureFlags, parseFeatureFlags(.array([.bool(false)])))
    }

    func test_switchesGuestWaiversOnOnlyForALiteralTrue() {
        XCTAssertEqual(true, parseFeatureFlags(row("guest_waivers_enabled", .bool(true)))["guest_waivers"])
        let values: [JSONValue] = [.string("true"), .int(1), .null, .string("yes"), .array([]), .object([]), .bool(false)]
        for value in values { XCTAssertEqual(false, parseFeatureFlags(row("guest_waivers_enabled", value))["guest_waivers"], value.serialized) }
    }

    func test_roundTripsTheDefaultRow() {
        let stored = JSONValue.object(features.map { (featureField($0.id), .bool($0.defaultOn)) })
        XCTAssertEqual(defaultFeatureFlags, parseFeatureFlags(stored))
    }

    func test_allowsAnEnabledFeatureAndRedirectsADisabledOneWithoutAccess() {
        XCTAssertEqual(.allow, featureGate(true, false))
        XCTAssertEqual(.allow, featureGate(true, true))
        XCTAssertEqual(.redirect, featureGate(false, false))
        XCTAssertEqual(.banner, featureGate(false, true))
    }
}
