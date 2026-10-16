import XCTest
@testable import ClubLadder

// Port of AnnouncementsTest.kt (announcement-visibility.test.ts, less the
// unread count, and the strip cases of announcement-markdown.test.ts).
final class AnnouncementsTests: XCTestCase {
    func test_keepsRowsWithNoExpiryAndRowsThatHaveNotExpired() {
        XCTAssertEqual("expires_at.is.null,expires_at.gt.2026-08-11T00:00:00.000Z", announcementExpiryFilter("2026-08-11T00:00:00.000Z"))
    }

    func test_usesTheTwoColumnSeasonShapeAndDropsItBetweenTerms() {
        let filter = announcementSeasonFilter("season-1")
        XCTAssertEqual("all_seasons.eq.true,season_id.eq.season-1", filter)
        XCTAssertFalse(filter!.contains("season_id.is.null"))
        XCTAssertNil(announcementSeasonFilter(nil))
        XCTAssertNil(announcementSeasonFilter(""))
    }

    func test_matchesTheAudienceAgainstTheViewer() {
        XCTAssertTrue(isAddressedTo("all", "competitive", false))
        XCTAssertTrue(isAddressedTo("all", "recreational", false))
        XCTAssertTrue(isAddressedTo("competitive", "competitive", false))
        XCTAssertFalse(isAddressedTo("competitive", "recreational", false))
        XCTAssertTrue(isAddressedTo("recreational", "recreational", false))
        XCTAssertTrue(isAddressedTo("eligible_only", "recreational", true))
        XCTAssertFalse(isAddressedTo("eligible_only", "recreational", false))
        XCTAssertFalse(isAddressedTo("eligible_only", "competitive", false))
        XCTAssertFalse(isAddressedTo("varsity", "competitive", false))
        XCTAssertFalse(isAddressedTo(nil, "competitive", false))
        XCTAssertFalse(isAddressedTo(nil, nil, false))
    }

    func test_stripsInlineMarkersAndKeepsTheWords() {
        XCTAssertEqual("Courts closed on Friday", plainAnnouncementText("**Courts closed** on *Friday*"))
        XCTAssertEqual("lined and gone", plainAnnouncementText("__lined__ and ~~gone~~"))
        XCTAssertEqual("type npm test here", plainAnnouncementText("type `npm test` here"))
    }

    func test_stripsLineLeadingMarkers() {
        XCTAssertEqual("Heading", plainAnnouncementText("## Heading"))
        XCTAssertEqual("One\nThree", plainAnnouncementText("# One\n### Three"))
        XCTAssertEqual("a\nb", plainAnnouncementText("- a\n* b"))
        XCTAssertEqual("quoted", plainAnnouncementText("> quoted"))
    }

    func test_leavesSingleUnderscoresAndUnclosedMarkersAlone() {
        XCTAssertEqual("read some_file_name.pdf", plainAnnouncementText("read some_file_name.pdf"))
        XCTAssertEqual("_this_", plainAnnouncementText("_this_"))
        XCTAssertEqual("**unclosed", plainAnnouncementText("**unclosed"))
        XCTAssertEqual("*a\n*b", plainAnnouncementText("*a\n*b"))
    }
}
