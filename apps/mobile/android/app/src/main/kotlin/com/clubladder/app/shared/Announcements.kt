package com.clubladder.app.shared

// Port of apps/player/src/lib/announcement-visibility.ts (the filters and
// isAddressedTo) and of stripAnnouncementMarkdown in
// packages/shared/src/utils/announcement-markdown.ts. Keep in step with them.

/** The .or() argument keeping unexpired rows. */
fun announcementExpiryFilter(nowIso: String): String = "expires_at.is.null,expires_at.gt.$nowIso"

/** The .or() argument for the season shape, or null between terms, when the clause is dropped. */
fun announcementSeasonFilter(activeSeasonId: String?): String? =
    if (activeSeasonId.isNullOrEmpty()) null else "all_seasons.eq.true,season_id.eq.$activeSeasonId"

/** An unrecognised audience is not shown. A null status never matches a null audience. */
fun isAddressedTo(targetAudience: String?, viewerStatus: String?, eligibilityFlag: Boolean?): Boolean = when (targetAudience) {
    "all" -> true
    "eligible_only" -> eligibilityFlag == true
    null, "" -> false
    else -> targetAudience == viewerStatus
}

private val PAIRED = listOf("**", "__", "~~", "*", "`")
private val LEADING = listOf("### ", "## ", "# ", "- ", "* ", "> ")

/**
 * The club's markdown as plain text, keeping every character a reader was meant
 * to read. An unclosed marker and a single underscore are left alone; pairs are
 * line-bounded; backtick contents are kept raw.
 */
fun plainAnnouncementText(text: String): String = text.split("\n").joinToString("\n") { line ->
    val marker = LEADING.firstOrNull { line.startsWith(it) }
    stripPaired(if (marker != null) line.substring(marker.length) else line)
}

private fun stripPaired(line: String): String {
    val out = StringBuilder()
    var i = 0
    while (i < line.length) {
        var matched = false
        for (marker in PAIRED) {
            if (!line.startsWith(marker, i)) continue
            val close = line.indexOf(marker, i + marker.length)
            if (close <= i + marker.length) continue
            val inner = line.substring(i + marker.length, close)
            out.append(if (marker == "`") inner else stripPaired(inner))
            i = close + marker.length
            matched = true
            break
        }
        if (matched) continue
        out.append(line[i])
        i++
    }
    return out.toString()
}
