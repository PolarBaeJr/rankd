import XCTest
@testable import ClubLadder

// Port of AvatarToneTest.kt.
final class AvatarToneTests: XCTestCase {
    func test_takesTheFirstLetterOfTheFirstTwoWordsUpperCased() {
        XCTAssertEqual("AL", avatarInitials("ada Lovelace King"))
        XCTAssertEqual("A", avatarInitials("Ada"))
    }

    func test_drawsAQuestionMarkForNoName() {
        XCTAssertEqual("?", avatarInitials(""))
    }

    func test_skipsTheEmptyWordADoubleSpaceLeaves() {
        XCTAssertEqual("AL", avatarInitials("Ada  Lovelace"))
    }

    func test_picksTheWebsTone() {
        // "abc": ((97 * 31 + 98) * 31 + 99) = 96354, 96354 % 7 = 6, so tone 7.
        XCTAssertEqual(7, avatarTone("abc"))
        // Past 2^31: the web's `>>> 0` keeps the hash unsigned, so no negative tone.
        XCTAssertEqual(3, avatarTone("Ada Lovelace"))
        XCTAssertEqual(1, avatarTone(""))
    }
}
