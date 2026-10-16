import XCTest
@testable import ClubLadder

// Port of SessionTrackTest.kt (packages/shared/src/utils/__tests__/session-track.test.ts).
final class SessionTrackTests: XCTestCase {
    private let playerStatuses = ["competitive", "recreational", "pending_approval", "suspended"]

    func test_returnsOnlySessionGroupValuesForEveryKnownStatus() {
        for status in playerStatuses {
            for track in visibleTracksFor(status) { XCTAssertTrue(sessionTracks.contains(track), "\(track) from \(status)") }
        }
    }

    func test_staysInsideTheVocabularyForAStatusThisBuildHasNeverSeen() {
        for status in ["alumni", "inactive", "", "ALL", nil] as [String?] {
            for track in visibleTracksFor(status) { XCTAssertTrue(sessionTracks.contains(track), "\(track) from \(String(describing: status))") }
        }
    }

    func test_showsAMemberWithNoAssignedTrackEveryTrackThereIs() {
        for status in ["pending_approval", "suspended"] {
            XCTAssertEqual(sessionTracks.sorted(), visibleTracksFor(status).sorted())
        }
    }

    func test_narrowsAMemberWhoHasATrackToTheirOwnNightsAndTheClubWideOnes() {
        XCTAssertEqual(["competitive", "all"], visibleTracksFor("competitive"))
        XCTAssertEqual(["recreational", "all"], visibleTracksFor("recreational"))
    }

    func test_neverWithholdsTheClubWideNightsFromAnyone() {
        for status in (playerStatuses + ["alumni"]).map(Optional.some) + [nil] {
            XCTAssertTrue(visibleTracksFor(status).contains("all"))
        }
    }

    func test_pinsTheSessionGroupVocabularyAgainstTheEnum() {
        XCTAssertEqual(["competitive", "recreational", "all"], sessionTracks)
    }

    // Kotlin checks for a fresh list object; a Swift array is a value, so the
    // caller changing its copy must leave the next caller's untouched.
    func test_handsBackAListTheCallerMayKeep() {
        var first = visibleTracksFor("pending_approval")
        let second = visibleTracksFor("pending_approval")
        XCTAssertEqual(first, second)
        first.append("x")
        XCTAssertEqual(sessionTracks, visibleTracksFor("pending_approval"))
    }
}
