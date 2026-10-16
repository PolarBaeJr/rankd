import XCTest
@testable import ClubLadder

// Port of AuthErrorsTest.kt, which mirrors packages/shared auth-errors.test.ts.
final class AuthErrorsTests: XCTestCase {
    func test_turnsThePerAddressCooldownIntoACodeWasSentWithTheSecondsLeft() {
        XCTAssertEqual(
            "A code was sent to this email moments ago. Check your inbox, or ask for a new one in 32 seconds.",
            friendlyAuthError("For security purposes, you can only request this after 32 seconds."),
        )
        XCTAssertTrue(friendlyAuthError("you can only request this after 1 second").hasSuffix("in 1 second."))
    }

    func test_keepsAGenericMessageForOtherRateLimits() {
        XCTAssertEqual("Too many attempts. Please wait a minute before trying again.", friendlyAuthError("email rate limit exceeded"))
    }

    func test_mapsAnEmptyGatewayBodyAndPassesAnythingElseThrough() {
        XCTAssertTrue(friendlyAuthError("{}").contains("reaching the server"))
        XCTAssertEqual("Token has expired or is invalid", friendlyAuthError("Token has expired or is invalid"))
    }

    func test_writesNoEmDash() {
        for m in ["{}", "email rate limit exceeded", "after 5 seconds"] {
            XCTAssertFalse(friendlyAuthError(m).contains("\u{2014}"))
        }
    }

    func test_prefersGoTruesOwnCode() {
        XCTAssertEqual("AUTH-201", authErrorCode("x", "over_email_send_rate_limit"))
        XCTAssertEqual("AUTH-202", authErrorCode("x", "over_request_rate_limit"))
        XCTAssertEqual("AUTH-203", authErrorCode("x", "otp_expired"))
        XCTAssertEqual("AUTH-204", authErrorCode("x", "signup_disabled"))
        XCTAssertEqual("AUTH-206", authErrorCode("x", "flow_state_expired"))
        XCTAssertEqual("AUTH-207", authErrorCode("x", "user_banned"))
    }

    func test_readsTheMessageTheWayFriendlyAuthErrorDoesWhenThereIsNoCode() {
        XCTAssertEqual("AUTH-201", authErrorCode("For security purposes, you can only request this after 32 seconds."))
        XCTAssertEqual("AUTH-202", authErrorCode("email rate limit exceeded"))
        XCTAssertEqual("AUTH-203", authErrorCode("Token has expired or is invalid"))
        XCTAssertEqual("AUTH-205", authErrorCode("{}"))
        XCTAssertEqual("AUTH-205", authErrorCode("Bad Gateway", status: 502))
        XCTAssertEqual("AUTH-000", authErrorCode("Something new"))
        XCTAssertEqual("AUTH-205", authErrorCode(nil))
    }

    func test_appendsTheCodeWithoutTouchingTheText() {
        XCTAssertEqual("\(friendlyAuthError("{}")) (AUTH-205)", withErrorCode(friendlyAuthError("{}"), "AUTH-205"))
    }
}
