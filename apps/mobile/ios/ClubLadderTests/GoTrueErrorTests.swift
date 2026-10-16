import XCTest
@testable import ClubLadder

// Port of GoTrueErrorTest.kt.
final class GoTrueErrorTests: XCTestCase {
    private func from(_ status: Int, _ body: String, _ version: String?, _ text: String) -> GoTrueError {
        GoTrueError.from(status: status, body: body, apiVersionHeader: version, statusText: text)
    }

    func test_prefersMsgOverMessage() {
        XCTAssertEqual("first", from(400, #"{"msg":"first","message":"second"}"#, nil, "").message)
        XCTAssertEqual("second", from(400, #"{"message":"second","error":"third"}"#, nil, "").message)
        XCTAssertEqual("desc", from(400, #"{"error_description":"desc","error":"x"}"#, nil, "").message)
    }

    // The gateway's empty 503 body is how "{}" reaches friendlyAuthError.
    func test_fallsBackToTheRawJsonWhenNothingNamesTheFailure() {
        let e = from(503, "{}", nil, "Service Unavailable")
        XCTAssertEqual("{}", e.message)
        XCTAssertEqual(503, e.status)
    }

    func test_saysTheStatusForAGatewayPageThatIsNotJson() {
        XCTAssertEqual("HTTP 503", from(503, "<html>down</html>", nil, "").message)
        XCTAssertEqual("Bad Gateway", from(502, "<html/>", nil, "Bad Gateway").message)
    }

    func test_readsCodeOnlyFromAnApiVersionThatHasOneElseErrorCode() {
        let body = #"{"code":"otp_disabled","error_code":"legacy","msg":"Signups not allowed for otp"}"#
        XCTAssertEqual("otp_disabled", from(422, body, "2024-01-01", "").code)
        XCTAssertEqual("legacy", from(422, body, "2023-12-31", "").code)
        XCTAssertEqual("legacy", from(422, body, nil, "").code)
        XCTAssertNil(from(422, #"{"code":42}"#, "2024-01-01", "").code)
    }

    func test_keepsANetworkFailureAsStatus0() {
        let e = from(0, "Unable to resolve host", nil, "")
        XCTAssertEqual(0, e.status)
        XCTAssertEqual("Unable to resolve host", e.message)
    }
}
