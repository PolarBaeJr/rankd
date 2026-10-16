import XCTest
@testable import ClubLadder

// iOS only: the ordered JSON layer that stands in for kotlinx.serialization.
final class JSONValueTests: XCTestCase {
    func test_roundTripsCompactJsonByteForByte() {
        let text = #"{"b":1,"a":[true,false,null,"x",-2.5,{"z":{}}],"c":"d"}"#
        XCTAssertEqual(text, JSONValue.parse(text)?.serialized)
    }

    func test_keepsKeyOrderAsWritten() {
        let value = JSONValue.parse(#"{"z":1,"a":2,"m":3}"#)
        XCTAssertEqual(["z", "a", "m"], value?.objectValue?.map(\.0))
    }

    func test_dropsWhitespaceWhenPrinting() {
        XCTAssertEqual(#"{"a":[1,2],"b":{"c":"d e"}}"#, JSONValue.parse(" { \"a\" : [ 1 , 2 ] ,\n\"b\":{\"c\":\"d e\"} } ")?.serialized)
    }

    func test_escapesTheWayKotlinxDoes() {
        let value = JSONValue.string("q\" b\\ n\n r\r t\t bs\u{08} ff\u{0C} ctl\u{01}\u{1F} slash/ e\u{00E9}")
        XCTAssertEqual(#""q\" b\\ n\n r\r t\t bs\b ff\f ctl\u0001\u001f slash/ e"# + "\u{00E9}\"", value.serialized)
    }

    func test_readsEscapesAndSurrogatePairs() {
        // U+1D11E, a character outside the Basic Multilingual Plane.
        XCTAssertEqual(.string("a/b\u{00E9}\u{1D11E}"), JSONValue.parse(#""a\/b\u00e9\ud834\udd1e""#))
    }

    func test_keepsBoolsApartFromNumbers() {
        let value = JSONValue.parse(#"{"t":true,"one":1,"s":"true"}"#)
        XCTAssertEqual(true, value?["t"]?.bool)
        XCTAssertNil(value?["one"]?.bool)
        XCTAssertNil(value?["s"]?.bool)
        XCTAssertNil(value?["t"]?.int)
        XCTAssertEqual("true", value?["t"]?.serialized)
    }

    func test_readsAnIntegerLiteralAsAnIntegerSoItNeverGainsAFraction() {
        let value = JSONValue.parse(#"{"timeout":60000,"big":9007199254740993,"f":1.0,"e":1e3}"#)
        XCTAssertEqual(.int(60000), value?["timeout"])
        XCTAssertEqual(.int(9_007_199_254_740_993), value?["big"])
        XCTAssertEqual(.double(1.0), value?["f"])
        XCTAssertEqual(60000.0, value?["timeout"]?.double)
        XCTAssertEqual(#"{"timeout":60000,"big":9007199254740993,"f":1.0,"e":1000.0}"#, value?.serialized)
    }

    func test_fallsBackToADoubleOnIntegerOverflow() {
        XCTAssertEqual(.double(1e20), JSONValue.parse("100000000000000000000"))
    }

    func test_refusesTrailingJunkAndMalformedInput() {
        for text in ["{} x", "[1,]", "{\"a\":}", "\"open", "01", "tru", "", "not json", "{'a':1}", "[1 2]"] {
            XCTAssertNil(JSONValue.parse(text), text)
        }
    }

    func test_keepsTheLastValueForARepeatedKeyInItsFirstPlaceAsKotlinxDoes() {
        let value = JSONValue.parse(#"{"a":1,"b":0,"a":2}"#)
        XCTAssertEqual(.int(2), value?["a"])
        XCTAssertEqual(#"{"a":2,"b":0}"#, value?.serialized)
    }
}
