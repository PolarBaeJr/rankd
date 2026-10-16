import Foundation

// Port of the website's AvatarChip (packages/ui/src/components/AvatarChip.tsx),
// via AvatarTone.kt, so a member wears the same initials and colour everywhere.

/// Up to two initials, one per space-separated word; "?" for no name.
func avatarInitials(_ name: String) -> String {
    let source = name.isEmpty ? "?" : name
    return source.split(separator: " ", omittingEmptySubsequences: true)
        .compactMap(\.first)
        .prefix(2)
        .map(String.init)
        .joined()
        .uppercased()
}

/// Tone 1 to 7, the web's `h * 31 + code` hash kept to 32 bits, over UTF-16
/// units as Kotlin's Char.code is.
func avatarTone(_ seed: String) -> Int {
    var h: UInt64 = 0
    for unit in seed.utf16 {
        h = (h &* 31 &+ UInt64(unit)) & 0xFFFF_FFFF
    }
    return Int(h % 7) + 1
}
