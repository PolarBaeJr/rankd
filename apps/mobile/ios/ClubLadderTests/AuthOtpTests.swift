import XCTest
@testable import ClubLadder

// Port of AuthOtpTest.kt, which mirrors packages/shared auth-otp.test.ts.
final class AuthOtpTests: XCTestCase {
    func test_triesTheExistingAccountTypeFirstOnSignIn() {
        XCTAssertEqual(["recovery", "signup"], signinOtpTypes)
    }

    func test_fallsThroughOnlyOnATypeMismatch() {
        XCTAssertTrue(shouldTryNextOtpType("Invalid email verification type"))
        XCTAssertFalse(shouldTryNextOtpType("Email rate limit exceeded"))
    }

    func test_fallsThroughOnGoTruesExpiredOrInvalidAnswer() {
        XCTAssertTrue(shouldTryNextOtpType("Token has expired or is invalid"))
    }

    // JS regex.test is a search, not a whole-string match.
    func test_matchesAnywhereInTheMessageAsAJsRegexTestDoes() {
        XCTAssertTrue(shouldTryNextOtpType("Error: token has EXPIRED OR IS INVALID, request another"))
        XCTAssertTrue(isUnknownAccountError("GoTrue says: Signups not allowed for otp today"))
    }

    func test_recognisesGoTrueRefusingToCreateAnAccount() {
        XCTAssertTrue(isUnknownAccountError("x", "otp_disabled"))
        XCTAssertTrue(isUnknownAccountError("Signups not allowed for otp"))
        XCTAssertTrue(isUnknownAccountError("otp_disabled"))
    }

    func test_leavesEveryOtherFailureToTheGenericHandler() {
        XCTAssertFalse(isUnknownAccountError(nil))
        XCTAssertFalse(isUnknownAccountError(""))
        XCTAssertFalse(isUnknownAccountError("Token has expired or is invalid"))
    }

    func test_retriesAGatewayBlip() {
        XCTAssertTrue(shouldRetryOtpSend("{}", nil, 503))
        XCTAssertTrue(shouldRetryOtpSend("", nil, nil))
        XCTAssertTrue(shouldRetryOtpSend("[object Object]", nil, nil))
    }

    func test_neverRetriesAnUnknownAccount() {
        XCTAssertFalse(shouldRetryOtpSend("Signups not allowed for otp", "otp_disabled", 422))
    }

    func test_neverRetriesARateLimitWhichWouldOnlyPushItFurther() {
        XCTAssertFalse(shouldRetryOtpSend("Email rate limit exceeded", nil, 429))
        XCTAssertFalse(shouldRetryOtpSend("For security purposes, you can only request this after 30 seconds.", nil, nil))
    }

    func test_doesNotRetryAnOrdinaryFailure() {
        XCTAssertFalse(shouldRetryOtpSend("Unable to validate email address", nil, 400))
    }
}
