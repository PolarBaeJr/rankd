import SwiftUI

// The club website's dark theme tokens (apps/player/src/app/globals.css), as
// Theme.kt resolved them. The app is dark only.

extension Color {
    /// 0xAARRGGBB, as Compose writes a colour.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: Double((hex >> 24) & 0xFF) / 255,
        )
    }
}

enum Palette {
    static let background = Color(hex: 0xFF0A0A0A)
    static let surface = Color(hex: 0xFF111111)
    static let surface2 = Color(hex: 0xFF1A1A1A)
    static let surface3 = Color(hex: 0xFF232323)
    static let line = Color(hex: 0x14FFFFFF)
    static let line2 = Color(hex: 0x24FFFFFF)
    static let text = Color(hex: 0xFFF0F0F0)
    static let ink2 = Color(hex: 0xFFC8C8C8)
    static let muted = Color(hex: 0xFF888888)
    static let dim = Color(hex: 0xFF666666)
    static let faint = Color(hex: 0xFF444444)
    static let placeholder = Color(hex: 0xFF565656)
    static let accent = Color(hex: 0xFFCC0000)
    static let redInk = Color(hex: 0xFFA30000)
    static let redBorder = Color(hex: 0x4DCC0000)
    static let danger = Color(hex: 0xFFCC0000)
    static let highlight = Color(hex: 0x1ACC0000)
    static let win = Color(hex: 0xFF4ADE80)
    static let winWash = Color(hex: 0x1A4ADE80)
    static let warning = Color(hex: 0xFFFBBF24)
    static let gold = Color(hex: 0xFFEAB308)
    static let silver = Color(hex: 0xFFBCBDC0)
    static let bronze = Color(hex: 0xFFC68A55)
}

extension Palette {
    /// The calendar's tone marks, as globals.css colours them.
    static func tone(_ tone: CalendarTone) -> Color {
        switch tone {
        case .open: return win
        case .closed: return line2
        case .club: return gold
        case .tournament: return ink2
        case .cancelled: return line2
        }
    }
}
