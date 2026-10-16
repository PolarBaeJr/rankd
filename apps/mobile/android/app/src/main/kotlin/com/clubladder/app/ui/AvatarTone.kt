package com.clubladder.app.ui

// Port of the website's AvatarChip (packages/ui/src/components/AvatarChip.tsx),
// so a member wears the same initials and colour in the app as on the site.

/** Up to two initials, one per space-separated word; "?" for no name. */
fun avatarInitials(name: String): String =
    name.ifEmpty { "?" }.split(' ').mapNotNull { it.firstOrNull() }.take(2).joinToString("").uppercase()

/** Tone 1 to 7, the web's `h * 31 + code` hash kept to 32 bits. */
fun avatarTone(seed: String): Int {
    var h = 0L
    for (c in seed) h = (h * 31 + c.code) and 0xFFFFFFFFL
    return (h % 7).toInt() + 1
}
