import XCTest
@testable import ClubLadder

// Port of TokenSessionTest.kt.
final class TokenSessionTests: XCTestCase {
    private let now: Int64 = 1_800_000_000

    // 'u?>' encodes to base64url with a '-' or '_' and needs padding, so the
    // payload exercises both the URL alphabet and the unpadded form.
    private let access = testJwt(#"{"sub":"u1","email":"m@example.invalid","note":"u?>"}"#)

    private func reply(_ accessToken: String? = nil, extra: String = #""expires_at":1800003600"#) -> String {
        #"{"access_token":""# + (accessToken ?? access) + #"","refresh_token":"r","# + extra + #","token_type":"bearer"}"#
    }

    func test_readsTheUserFromTheTokensSubAndEmailClaims() {
        XCTAssertEqual(
            StoredSession(accessToken: access, refreshToken: "r", expiresAtEpochSec: 1_800_003_600, userId: "u1", email: "m@example.invalid"),
            parseTokenSession(reply(), nowEpochSec: now),
        )
    }

    func test_prefersExpiresAtAndCountsExpiresInFromNowWithoutIt() {
        XCTAssertEqual(1_800_003_600, parseTokenSession(reply(extra: #""expires_at":1800003600,"expires_in":10"#), nowEpochSec: now)?.expiresAtEpochSec)
        XCTAssertEqual(now + 3600, parseTokenSession(reply(extra: #""expires_in":3600"#), nowEpochSec: now)?.expiresAtEpochSec)
    }

    func test_leavesTheEmailOutWhenTheTokenHasNone() {
        let token = testJwt(#"{"sub":"u1"}"#)
        XCTAssertNotNil(parseTokenSession(reply(token), nowEpochSec: now))
        XCTAssertNil(parseTokenSession(reply(token), nowEpochSec: now)?.email)
    }

    func test_refusesATokenWithNoSub() {
        XCTAssertNil(parseTokenSession(reply(testJwt(#"{"email":"m@example.invalid"}"#)), nowEpochSec: now))
    }

    func test_refusesATokenThatIsNotAJwt() {
        XCTAssertNil(parseTokenSession(reply("not-a-jwt"), nowEpochSec: now))
        XCTAssertNil(parseTokenSession(reply("a.!!!.c"), nowEpochSec: now))
        XCTAssertNil(parseTokenSession(reply("a.bm90IGpzb24.c"), nowEpochSec: now))
    }

    func test_refusesABodyThatIsNotASession() {
        XCTAssertNil(parseTokenSession("not json", nowEpochSec: now))
        XCTAssertNil(parseTokenSession("[]", nowEpochSec: now))
        XCTAssertNil(parseTokenSession(#"{"error":"Passkey sign-in failed"}"#, nowEpochSec: now))
        XCTAssertNil(parseTokenSession(#"{"access_token":""# + access + #"","refresh_token":"r"}"#, nowEpochSec: now))
    }
}
