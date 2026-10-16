import SwiftUI
import UIKit

// The website's three faces (apps/player/src/app/layout.tsx), latin only,
// registered by Info.plist UIAppFonts. Barlow ships 400, 600 and 700; a 500
// request lands on 400, as on Android. JetBrains Mono is one variable file, so
// every weight is a setting on its wght axis. Sizes scale with Dynamic Type the
// way Android sp does.

enum FontName {
    static let barlowRegular = "Barlow-Regular"
    static let barlowSemiBold = "Barlow-SemiBold"
    static let barlowBold = "Barlow-Bold"
    static let barlowCondensedBold = "BarlowCondensed-Bold"
    static let jetBrainsMono = "JetBrainsMono-Regular"
}

/// One named text treatment: face, size, line height and tracking (in em).
struct TextSpec: Sendable {
    enum Face: Sendable {
        case barlow(weight: Int)
        case condensed
        case mono(weight: Int)
    }

    var face: Face
    var size: CGFloat
    var lineHeight: CGFloat? = nil
    var trackingEm: CGFloat = 0
    var relativeTo: Font.TextStyle = .body

    func font(_ dynamicType: DynamicTypeSize) -> Font {
        switch face {
        case let .barlow(weight):
            let name = weight >= 700 ? FontName.barlowBold : weight >= 600 ? FontName.barlowSemiBold : FontName.barlowRegular
            return .custom(name, size: size, relativeTo: relativeTo)
        case .condensed:
            return .custom(FontName.barlowCondensedBold, size: size, relativeTo: relativeTo)
        case let .mono(weight):
            return Font(TextSpec.monoFont(size: size, weight: weight, style: relativeTo.uiStyle, dynamicType: dynamicType) as CTFont)
        }
    }

    /// The size after Dynamic Type, for tracking and line height.
    func scaledSize(_ dynamicType: DynamicTypeSize) -> CGFloat {
        UIFontMetrics(forTextStyle: relativeTo.uiStyle)
            .scaledValue(for: size, compatibleWith: UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicType)))
    }

    static func monoFont(size: CGFloat, weight: Int, style: UIFont.TextStyle, dynamicType: DynamicTypeSize) -> UIFont {
        let wght = 0x77676874
        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: FontName.jetBrainsMono,
            UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): [wght: weight],
        ])
        let base = UIFont(descriptor: descriptor, size: size)
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicType))
        return UIFontMetrics(forTextStyle: style).scaledFont(for: base, compatibleWith: traits)
    }
}

private extension Font.TextStyle {
    var uiStyle: UIFont.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title: return .title1
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .subheadline: return .subheadline
        case .callout: return .callout
        case .footnote: return .footnote
        case .caption: return .caption1
        case .caption2: return .caption2
        default: return .body
        }
    }
}

private struct Styled: ViewModifier {
    let spec: TextSpec
    @Environment(\.dynamicTypeSize) private var dynamicType

    func body(content: Content) -> some View {
        let size = spec.scaledSize(dynamicType)
        let lineSpacing = spec.lineHeight.map { max(0, $0 / spec.size * size - size * 1.2) } ?? 0
        content
            .font(spec.font(dynamicType))
            .tracking(spec.trackingEm * size)
            .lineSpacing(lineSpacing)
    }
}

extension View {
    func textStyle(_ spec: TextSpec) -> some View { modifier(Styled(spec: spec)) }
}

/// The website's named text treatments (Type.kt). Colour and upper case are set where they are used.
enum TypeStyle {
    static let pageTitle = TextSpec(face: .condensed, size: 34, lineHeight: 34, trackingEm: -0.015, relativeTo: .largeTitle)
    static let pageEyebrow = TextSpec(face: .mono(weight: 500), size: 11, trackingEm: 0.12, relativeTo: .caption)
    static let pageSub = TextSpec(face: .barlow(weight: 400), size: 14, lineHeight: 21, relativeTo: .subheadline)
    static let cardTitle = TextSpec(face: .condensed, size: 18, trackingEm: -0.01, relativeTo: .headline)
    static let cardSub = TextSpec(face: .barlow(weight: 400), size: 13, relativeTo: .footnote)
    static let label = TextSpec(face: .mono(weight: 500), size: 10, trackingEm: 0.16, relativeTo: .caption2)
    static let statLabel = TextSpec(face: .mono(weight: 400), size: 10, trackingEm: 0.1, relativeTo: .caption2)
    static let statValue = TextSpec(face: .condensed, size: 28, lineHeight: 28, trackingEm: -0.02, relativeTo: .title)
    static let figure = TextSpec(face: .mono(weight: 700), size: 46, trackingEm: -0.03, relativeTo: .largeTitle)
    static let button = TextSpec(face: .barlow(weight: 700), size: 14, trackingEm: 0.16, relativeTo: .subheadline)
    static let tag = TextSpec(face: .mono(weight: 500), size: 11, trackingEm: 0.02, relativeTo: .caption)
    static let chip = TextSpec(face: .barlow(weight: 500), size: 13, relativeTo: .footnote)
    static let rowTitle = TextSpec(face: .barlow(weight: 600), size: 14, relativeTo: .subheadline)
    static let rowSub = TextSpec(face: .mono(weight: 400), size: 11, relativeTo: .caption)
    static let lrRank = TextSpec(face: .mono(weight: 600), size: 14, relativeTo: .subheadline)
    static let lrValue = TextSpec(face: .mono(weight: 700), size: 16, relativeTo: .callout)
    static let sessDate = TextSpec(face: .mono(weight: 400), size: 11, trackingEm: 0.14, relativeTo: .caption)
    static let sessTime = TextSpec(face: .mono(weight: 400), size: 15, relativeTo: .callout)
    static let sessMeta = TextSpec(face: .mono(weight: 400), size: 12, relativeTo: .caption)
    static let brand = TextSpec(face: .condensed, size: 15, trackingEm: -0.01, relativeTo: .headline)
    static let signinTitle = TextSpec(face: .condensed, size: 30, lineHeight: 30, trackingEm: 0.2, relativeTo: .title)
    static let signinHeading = TextSpec(face: .condensed, size: 26, trackingEm: -0.02, relativeTo: .title2)
    static let tabLabel = TextSpec(face: .barlow(weight: 500), size: 10, relativeTo: .caption2)

    /// Plain Barlow at a size, for the one-off texts Kotlin sizes inline.
    static func body(_ size: CGFloat, weight: Int = 400, lineHeight: CGFloat? = nil, relativeTo: Font.TextStyle = .body) -> TextSpec {
        TextSpec(face: .barlow(weight: weight), size: size, lineHeight: lineHeight, relativeTo: relativeTo)
    }
}
