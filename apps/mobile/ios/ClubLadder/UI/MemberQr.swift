import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

/// The member's challenge QR, the same link the website's profile QR encodes
/// (packages/shared/src/utils/challenge-qr.ts): scanning it opens the new
/// challenge form with this member picked. Never an authorisation; the
/// challenge still goes through createChallenge and the club's rules.
func challengeQrUrl(siteUrl: String, playerId: String) -> String { "\(siteUrl)/challenges/new?opponent=\(playerId)" }

enum MemberQr {
    static let quietModules = 4

    /// The code's modules, row by row, true for dark. CoreImage pads its output
    /// with a margin of its own that it does not document, so the dark modules'
    /// bounding box is found and everything outside it dropped.
    static func modules(_ text: String) -> [[Bool]]? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let context = CIContext(options: [.useSoftwareRenderer: true])
        guard let raw = context.createCGImage(output, from: output.extent) else { return nil }
        let width = raw.width
        let height = raw.height
        var pixels = [UInt8](repeating: 255, count: width * height)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let ctx = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue,
            ) else { return false }
            ctx.interpolationQuality = .none
            ctx.draw(raw, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width where pixels[y * width + x] < 128 {
                minX = min(minX, x)
                maxX = max(maxX, x)
                minY = min(minY, y)
                maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY, maxX - minX == maxY - minY else { return nil }
        return (minY...maxY).map { y in (minX...maxX).map { x in pixels[y * width + x] < 128 } }
    }

    /// Black modules on white with a four-module quiet zone, whatever the
    /// app's own dark theme: scanners expect dark on light. Drawn at a whole
    /// number of pixels per module, so no module is blurred into its neighbour.
    static func image(_ text: String, pixelsPerModule scale: Int) -> CGImage? {
        guard let grid = modules(text), scale > 0 else { return nil }
        let cells = grid.count + quietModules * 2
        let side = cells * scale
        guard let ctx = CGContext(
            data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue,
        ) else { return nil }
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: side, height: side))
        ctx.setFillColor(gray: 0, alpha: 1)
        for (row, line) in grid.enumerated() {
            for (col, dark) in line.enumerated() where dark {
                // CoreGraphics counts rows from the bottom.
                let y = side - (row + quietModules + 1) * scale
                ctx.fill(CGRect(x: (col + quietModules) * scale, y: y, width: scale, height: scale))
            }
        }
        return ctx.makeImage()
    }
}

struct MemberQrCard: View {
    let siteUrl: String
    let playerId: String
    @State private var image: CGImage?

    var body: some View {
        let url = challengeQrUrl(siteUrl: siteUrl, playerId: playerId)
        Card {
            Text("Your challenge QR").foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
            Text("Anyone in the club can scan this to challenge you.")
                .foregroundStyle(Palette.muted)
                .textStyle(TypeStyle.cardSub)
                .padding(.top, 2)
                .padding(.bottom, 14)
            Group {
                if let image {
                    Image(decorative: image, scale: 1)
                        .interpolation(.none)
                        .resizable()
                        .aspectRatio(1, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .accessibilityElement()
                        .accessibilityLabel("Your challenge QR code")
                } else {
                    Color.white.aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            .frame(maxWidth: 240)
            .frame(maxWidth: .infinity)
        }
        // Drawn once per member and kept: 12 pixels a module is sharp at 240 points on a 3x screen.
        .task(id: url) { image = MemberQr.image(url, pixelsPerModule: 12) }
    }
}
