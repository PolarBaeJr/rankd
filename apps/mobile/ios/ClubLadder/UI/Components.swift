import SwiftUI

// The website's shared pieces (globals.css .card, .page-head, .btn, .tag), as
// Components.kt draws them. Cards carry no outer spacing: a screen spaces them.

struct Card<Content: View>: View {
    var padding: CGFloat = 20
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line, lineWidth: 1))
    }
}

struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .foregroundStyle(Palette.muted)
            .textStyle(TypeStyle.label)
            .padding(.bottom, 8)
    }
}

struct BodyText: View {
    let text: String
    var muted = false

    var body: some View {
        Text(text)
            .foregroundStyle(muted ? Palette.muted : Palette.text)
            .textStyle(TypeStyle.body(14, lineHeight: 21))
    }
}

/// The eyebrow's short red rule and red mono caption.
struct Eyebrow: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Palette.accent).frame(width: 24, height: 2)
            Text(text.uppercased()).foregroundStyle(Palette.accent).textStyle(TypeStyle.pageEyebrow)
        }
    }
}

/// The page's own title: an optional red eyebrow, the title with its red full stop.
struct PageHeader: View {
    let title: String
    var eyebrow: String? = nil
    var sub: String? = nil
    var padding = EdgeInsets(top: 20, leading: 16, bottom: 20, trailing: 16)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let eyebrow {
                Eyebrow(text: eyebrow).padding(.bottom, 10)
            }
            (Text(title).foregroundColor(Palette.text) + Text(".").foregroundColor(Palette.accent))
                .textStyle(TypeStyle.pageTitle)
            if let sub, !sub.isEmpty {
                Text(sub).foregroundStyle(Palette.muted).textStyle(TypeStyle.pageSub).padding(.top, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(padding)
    }
}

/// The header's red tile: faint 135 degree stripes under the white shuttle mark.
struct BrandTile: View {
    let size: CGFloat
    let corner: CGFloat
    let markSize: CGFloat

    var body: some View {
        ZStack {
            Palette.accent
            Canvas { context, canvasSize in
                let root2 = CGFloat(2).squareRoot()
                let step = 9 * root2
                var c = 8.5 * root2
                // Lines along x + y = c, one every 9pt measured across them.
                while c < canvasSize.width + canvasSize.height {
                    var path = Path()
                    path.move(to: CGPoint(x: c, y: 0))
                    path.addLine(to: CGPoint(x: 0, y: c))
                    context.stroke(path, with: .color(.white.opacity(0.08)), lineWidth: 1)
                    c += step
                }
            }
            Image("shuttle_mark")
                .renderingMode(.template)
                .resizable()
                .foregroundStyle(.white)
                .frame(width: markSize, height: markSize)
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: corner))
        .accessibilityHidden(true)
    }
}

struct PrimaryButton: View {
    let title: String
    var enabled = true
    var icon: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon {
                    Image(icon).renderingMode(.template).resizable().frame(width: 14, height: 14)
                }
                Text(title.uppercased()).textStyle(TypeStyle.button)
            }
            .foregroundStyle(enabled ? Color.white : Color.white.opacity(0.55))
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(enabled ? Palette.accent : Palette.accent.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
            .shadow(color: enabled ? Palette.accent.opacity(0.35) : .clear, radius: 8, y: 4)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

struct GhostButton: View {
    let title: String
    var enabled = true
    var icon: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let icon {
                    Image(icon).renderingMode(.template).resizable().frame(width: 18, height: 18)
                }
                Text(title.uppercased()).textStyle(TypeStyle.button)
            }
            .foregroundStyle(enabled ? Palette.ink2 : Palette.ink2.opacity(0.55))
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

struct TextLink: View {
    let text: String
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text)
                .underline()
                .foregroundStyle(Palette.muted)
                .textStyle(TypeStyle.body(12))
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

/// Something the member should read before going on: the web's red-washed notice box.
struct Notice: View {
    let text: String

    var body: some View {
        Text(text)
            .foregroundStyle(Palette.ink2)
            .textStyle(TypeStyle.body(13, lineHeight: 19))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Palette.highlight, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.redBorder, lineWidth: 1))
    }
}

/// A failure the member should see: red text on the red wash. Not SwiftUI's Alert.
struct AlertBox: View {
    let text: String

    var body: some View {
        Text(text)
            .foregroundStyle(Palette.danger)
            .textStyle(TypeStyle.body(13, lineHeight: 19))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Palette.highlight, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct Tag: View {
    let text: String
    let background: Color
    let color: Color

    var body: some View {
        Text(text)
            .foregroundStyle(color)
            .textStyle(TypeStyle.tag)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(background, in: RoundedRectangle(cornerRadius: 4))
    }
}

struct Pill: View {
    let text: String
    let background: Color
    let color: Color

    var body: some View {
        Text(text)
            .foregroundStyle(color)
            .textStyle(TypeStyle.body(12, weight: 500))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(background, in: Capsule())
    }
}

struct LoadingView: View {
    var body: some View {
        ProgressView()
            .tint(Palette.accent)
            .controlSize(.large)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A failed read, said as one. On the web a refused read rendered as an empty
/// list for months; here an error is never drawn as "nothing yet".
struct ErrorState: View {
    let message: String
    var onRetry: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 12) {
            Text(message)
                .foregroundStyle(Palette.danger)
                .textStyle(TypeStyle.body(14, lineHeight: 21))
                .multilineTextAlignment(.center)
            if let onRetry {
                Button(action: onRetry) {
                    Text("Try again".uppercased())
                        .foregroundStyle(Palette.ink2)
                        .textStyle(TypeStyle.button)
                        .padding(.horizontal, 20)
                        .frame(minHeight: 48)
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct EmptyState: View {
    let message: String

    var body: some View {
        Text(message)
            .foregroundStyle(Palette.muted)
            .textStyle(TypeStyle.body(14))
            .multilineTextAlignment(.center)
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
