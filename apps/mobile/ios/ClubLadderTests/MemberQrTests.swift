import CoreImage
import XCTest
@testable import ClubLadder

// iOS only: Android draws the QR from a library; here CoreImage makes it and
// the app trims CoreImage's own margin, so both the payload and the quiet zone
// are checked on the finished image.
final class MemberQrTests: XCTestCase {
    private let url = challengeQrUrl(siteUrl: "https://site.example.invalid", playerId: "0f8fad5b-d9cb-469f-a165-70867728950e")

    func test_encodesTheWebsitesChallengeLink() throws {
        XCTAssertEqual("https://site.example.invalid/challenges/new?opponent=0f8fad5b-d9cb-469f-a165-70867728950e", url)
        let image = try XCTUnwrap(MemberQr.image(url, pixelsPerModule: 8))
        let detector = try XCTUnwrap(CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        let found = detector.features(in: CIImage(cgImage: image)).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
        XCTAssertEqual([url], found)
    }

    func test_hasExactlyAFourModuleQuietZone() throws {
        let grid = try XCTUnwrap(MemberQr.modules(url))
        // A version 1 to 40 symbol is 21 to 177 modules square, in steps of four.
        XCTAssertTrue(grid.allSatisfy { $0.count == grid.count })
        XCTAssertEqual(1, grid.count % 4)
        // The three finder patterns sit in the corners: the grid has no margin left.
        XCTAssertTrue(grid[0][0] && grid[0][grid.count - 1] && grid[grid.count - 1][0])

        let scale = 5
        let image = try XCTUnwrap(MemberQr.image(url, pixelsPerModule: scale))
        XCTAssertEqual((grid.count + 8) * scale, image.width)
        let side = image.width
        var pixels = [UInt8](repeating: 0, count: side * side)
        pixels.withUnsafeMutableBytes { buffer in
            let ctx = CGContext(data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        func dark(_ x: Int, _ y: Int) -> Bool { pixels[y * side + x] < 128 }
        let quiet = 4 * scale
        let firstDarkRow = (0..<side).first { y in (0..<side).contains { dark($0, y) } }
        let firstDarkCol = (0..<side).first { x in (0..<side).contains { dark(x, $0) } }
        let lastDarkRow = (0..<side).last { y in (0..<side).contains { dark($0, y) } }
        XCTAssertEqual(quiet, firstDarkRow)
        XCTAssertEqual(quiet, firstDarkCol)
        XCTAssertEqual(side - quiet - 1, lastDarkRow)
        // Top-left module is dark, as in the grid: the image is not flipped.
        XCTAssertTrue(dark(quiet, quiet))
        XCTAssertEqual(grid[0][7], dark(quiet + 7 * scale, quiet))
    }
}
