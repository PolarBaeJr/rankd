import SwiftUI

// The web's dark avatar tones (globals.css .avatar[data-tone]), background then ink.
private let tones: [(Color, Color)] = [
    (Color(hex: 0xFF3A2B1F), Color(hex: 0xFFE5B880)),
    (Color(hex: 0xFF22362B), Color(hex: 0xFFA8D5B5)),
    (Color(hex: 0xFF2E2538), Color(hex: 0xFFC6B2E3)),
    (Color(hex: 0xFF3A1420), Color(hex: 0xFFF5A8B4)),
    (Color(hex: 0xFF1E2A3D), Color(hex: 0xFFA8BBD8)),
    (Color(hex: 0xFF32261A), Color(hex: 0xFFD8B88C)),
    (Color(hex: 0xFF2A2824), Color(hex: 0xFFBFB9B0)),
]

enum AvatarSize {
    case sm, md, xl

    var box: CGFloat {
        switch self {
        case .sm: return 32
        case .md: return 44
        case .xl: return 96
        }
    }

    var font: CGFloat {
        switch self {
        case .sm: return 11
        case .md: return 14
        case .xl: return 30
        }
    }
}

/// Initials on the member's tone, seeded by player id as on the web. Always
/// initials: a photo would need an image loader the app does not carry.
struct Avatar: View {
    let name: String
    let seed: String
    let size: AvatarSize
    var ring = false

    var body: some View {
        let (bg, fg) = tones[avatarTone(seed) - 1]
        Text(avatarInitials(name))
            .foregroundStyle(fg)
            .font(.custom(FontName.barlowCondensedBold, fixedSize: size.font))
            .lineLimit(1)
            .frame(width: size.box, height: size.box)
            .background(bg, in: Circle())
            .overlay(Circle().strokeBorder(Palette.line, lineWidth: 1))
            // The ring sits outside the tile, as the web's box-shadow does, so a
            // ringed avatar takes the same room as a plain one.
            .overlay {
                if ring {
                    Circle().stroke(Palette.accent, lineWidth: 2).padding(-2)
                }
            }
    }
}
