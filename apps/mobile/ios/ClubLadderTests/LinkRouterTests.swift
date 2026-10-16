import XCTest
@testable import ClubLadder

// Port of LinkRouterTest.kt, plus the iOS-only claimed-path and app-scheme rules.
final class LinkRouterTests: XCTestCase {
    private let site = "https://site.example.invalid"
    private let id = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private let token = String(repeating: "a", count: 48)

    private func parse(_ url: String) -> LinkRoute { LinkRouter.parse(url, siteUrl: site) }

    func test_routesEveryClaimedTabPath() {
        XCTAssertEqual(.tab(.leaderboard), parse("\(site)/leaderboard"))
        XCTAssertEqual(.tab(.myStats), parse("\(site)/my-stats"))
        XCTAssertEqual(.tab(.feed), parse("\(site)/feed"))
        XCTAssertEqual(.tab(.feed), parse("\(site)/sessions"))
        XCTAssertEqual(.tab(.membership), parse("\(site)/membership"))
        XCTAssertEqual(.tab(.membership), parse("\(site)/fees"))
        XCTAssertEqual(.tab(.challenges), parse("\(site)/challenges"))
    }

    func test_keepsASessionIdOnlyWhenItIsAUuid() {
        XCTAssertEqual(.tab(.feed, sessionId: id), parse("\(site)/sessions?s=\(id)"))
        XCTAssertEqual(.tab(.feed), parse("\(site)/sessions?s=nope"))
        XCTAssertEqual(.tab(.feed, sessionId: id), parse("\(site)/feed?s=\(id)"))
        XCTAssertEqual(.tab(.feed), parse("\(site)/feed?s=nope"))
    }

    func test_routesChallenges() {
        XCTAssertEqual(.challengeDetail(id: id), parse("\(site)/challenges/\(id)"))
        XCTAssertEqual(.challengeDetail(id: id.uppercased()), parse("\(site)/challenges/\(id.uppercased())"))
        XCTAssertEqual(.newChallenge(opponentId: id), parse("\(site)/challenges/new?opponent=\(id)"))
        XCTAssertEqual(.newChallenge(opponentId: nil), parse("\(site)/challenges/new"))
        XCTAssertEqual(.newChallenge(opponentId: nil), parse("\(site)/challenges/new?opponent=bad"))
        XCTAssertEqual(.newChallenge(opponentId: id), parse("\(site)/challenges/new?utm=x&opponent=\(id)"))
    }

    func test_sendsABadChallengeIdToTheBrowser() {
        XCTAssertEqual(.openInBrowser(url: "\(site)/challenges/not-a-uuid"), parse("\(site)/challenges/not-a-uuid"))
    }

    func test_routesACheckInTokenOnlyInTheWebsitesExactShape() {
        XCTAssertEqual(.checkIn(token: token), parse("\(site)/checkin/\(token)"))
        let short = String(repeating: "a", count: 47)
        let long = String(repeating: "a", count: 49)
        let upper = String(repeating: "A", count: 48)
        XCTAssertEqual(.openInBrowser(url: "\(site)/checkin/\(short)"), parse("\(site)/checkin/\(short)"))
        XCTAssertEqual(.openInBrowser(url: "\(site)/checkin/\(long)"), parse("\(site)/checkin/\(long)"))
        XCTAssertEqual(.openInBrowser(url: "\(site)/checkin/\(upper)"), parse("\(site)/checkin/\(upper)"))
    }

    func test_allowsATrailingSlashAndAnUpperCaseHost() {
        XCTAssertEqual(.tab(.leaderboard), parse("\(site)/leaderboard/"))
        XCTAssertEqual(.tab(.leaderboard), parse("https://SITE.example.invalid/leaderboard"))
        XCTAssertEqual(.tab(.leaderboard), parse("https://site.example.invalid:443/leaderboard"))
    }

    func test_sendsOtherPagesOfTheWebsiteToTheBrowser() {
        XCTAssertEqual(.openInBrowser(url: "\(site)/tournaments/checkin"), parse("\(site)/tournaments/checkin"))
        XCTAssertEqual(.openInBrowser(url: "\(site)/notifications"), parse("\(site)/notifications"))
        XCTAssertEqual(.openInBrowser(url: site), parse(site))
    }

    func test_refusesAnythingThatIsNotTheWebsitesOwnOrigin() {
        XCTAssertEqual(.notOurs, parse("https://other.example.invalid/leaderboard"))
        XCTAssertEqual(.notOurs, parse("http://site.example.invalid/leaderboard"))
        XCTAssertEqual(.notOurs, parse("https://site.example.invalid:8443/leaderboard"))
        XCTAssertEqual(.notOurs, parse("https://user@site.example.invalid/leaderboard"))
        XCTAssertEqual(.notOurs, parse("https://site.example.invalid.other.example.invalid/leaderboard"))
        XCTAssertEqual(.notOurs, parse("not a url at all"))
        XCTAssertEqual(.notOurs, parse("WIFI:S:club;T:WPA;P:secret;;"))
        XCTAssertEqual(.notOurs, LinkRouter.parse("\(site)/leaderboard", siteUrl: nil))
    }

    func test_knowsWhichPathsTheWebsiteHandsToTheApp() {
        for path in ["/leaderboard", "/my-stats/", "/sessions", "/membership", "/fees", "/challenges", "/challenges/new", "/challenges/\(id)", "/challenges/not-a-uuid-but-thirty-six-characters", "/checkin/\(token)", "/checkin/\(String(repeating: "A", count: 48))"] {
            XCTAssertTrue(LinkRouter.isClaimedPath("\(site)\(path)"), path)
        }
        for path in ["", "/", "/feed", "/challenges/not-a-uuid", "/checkin/\(String(repeating: "a", count: 47))", "/tournaments/checkin"] {
            XCTAssertFalse(LinkRouter.isClaimedPath("\(site)\(path)"), path)
        }
    }

    func test_readsTheAppSchemeAsTheSamePathOnTheWebsite() {
        XCTAssertEqual("\(site)/challenges", LinkRouter.fromAppScheme("clubladder://challenges", siteUrl: site))
        XCTAssertEqual("\(site)/challenges/\(id)", LinkRouter.fromAppScheme("clubladder://challenges/\(id)", siteUrl: site))
        XCTAssertEqual("\(site)/challenges/new?opponent=\(id)", LinkRouter.fromAppScheme("ClubLadder://challenges/new?opponent=\(id)", siteUrl: site))
        XCTAssertEqual("\(site)/leaderboard", LinkRouter.fromAppScheme("clubladder:///leaderboard", siteUrl: site))
        XCTAssertEqual(.challengeDetail(id: id), parse(LinkRouter.fromAppScheme("clubladder://challenges/\(id)", siteUrl: site)!))
        XCTAssertNil(LinkRouter.fromAppScheme("\(site)/challenges", siteUrl: site))
        XCTAssertNil(LinkRouter.fromAppScheme("other://challenges", siteUrl: site))
        XCTAssertNil(LinkRouter.fromAppScheme("clubladder://user@challenges", siteUrl: site))
        XCTAssertNil(LinkRouter.fromAppScheme("clubladder://challenges", siteUrl: nil))
    }
}
