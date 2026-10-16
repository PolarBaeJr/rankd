import Foundation

// Port of Announcements.kt: apps/player/src/lib/announcement-visibility.ts (the
// filters and isAddressedTo) and stripAnnouncementMarkdown in
// packages/shared/src/utils/announcement-markdown.ts. Keep in step with them.

/// The .or() argument keeping unexpired rows.
func announcementExpiryFilter(_ nowIso: String) -> String { "expires_at.is.null,expires_at.gt.\(nowIso)" }

/// The .or() argument for the season shape, or nil between terms, when the clause is dropped.
func announcementSeasonFilter(_ activeSeasonId: String?) -> String? {
    guard let activeSeasonId, !activeSeasonId.isEmpty else { return nil }
    return "all_seasons.eq.true,season_id.eq.\(activeSeasonId)"
}

/// An unrecognised audience is not shown. A nil status never matches a nil audience.
func isAddressedTo(_ targetAudience: String?, _ viewerStatus: String?, _ eligibilityFlag: Bool?) -> Bool {
    switch targetAudience {
    case "all"?: return true
    case "eligible_only"?: return eligibilityFlag == true
    case nil, ""?: return false
    case let audience?: return audience == viewerStatus
    }
}

private let pairedMarkers = ["**", "__", "~~", "*", "`"]
private let leadingMarkers = ["### ", "## ", "# ", "- ", "* ", "> "]

/**
 * The club's markdown as plain text, keeping every character a reader was meant
 * to read. An unclosed marker and a single underscore are left alone; pairs are
 * line-bounded; backtick contents are kept raw.
 */
func plainAnnouncementText(_ text: String) -> String {
    text.split(separator: "\n", omittingEmptySubsequences: false).map { line in
        let chars = Array(line)
        if let marker = leadingMarkers.first(where: { line.hasPrefix($0) }) {
            return stripPaired(Array(chars.dropFirst(marker.count)))
        }
        return stripPaired(chars)
    }.joined(separator: "\n")
}

private func starts(_ line: [Character], _ marker: [Character], at i: Int) -> Bool {
    i + marker.count <= line.count && Array(line[i..<i + marker.count]) == marker
}

private func stripPaired(_ line: [Character]) -> String {
    var out = ""
    var i = 0
    while i < line.count {
        var matched = false
        for markerText in pairedMarkers {
            let marker = Array(markerText)
            if !starts(line, marker, at: i) { continue }
            var close = -1
            var j = i + marker.count
            while j + marker.count <= line.count {
                if starts(line, marker, at: j) {
                    close = j
                    break
                }
                j += 1
            }
            if close <= i + marker.count { continue }
            let inner = Array(line[(i + marker.count)..<close])
            out += markerText == "`" ? String(inner) : stripPaired(inner)
            i = close + marker.count
            matched = true
            break
        }
        if matched { continue }
        out.append(line[i])
        i += 1
    }
    return out
}
