import XCTest
@testable import ClubLadder

// Port of ActiveSeasonTest.kt.
final class ActiveSeasonTests: XCTestCase {
    func test_noActiveSeasonMeansNoFilter() {
        XCTAssertNil(activeSeasonOrFilter(nil))
        XCTAssertNil(activeSeasonOrFilter(""))
    }

    func test_includesSeasonLessRowsAlongsideTheActiveSeason() {
        XCTAssertEqual("season_id.eq.s1,season_id.is.null", activeSeasonOrFilter("s1"))
    }
}
