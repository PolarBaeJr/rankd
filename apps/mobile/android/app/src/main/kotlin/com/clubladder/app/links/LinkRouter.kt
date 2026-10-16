package com.clubladder.app.links

import java.net.URI
import java.net.URISyntaxException

// Where a club website URL goes in the app: from a scanned QR code, or from a
// link Android handed over (App Links). Pure Kotlin, so every claimed path is
// tested.
//
// Only the website's own origin is ours: https, the same host (case aside) and
// the same port as the build's site URL, and no user info. Anything else on
// that origin opens in the browser; any other origin is not ours at all.

enum class TabTarget { FEED, LEADERBOARD, CHALLENGES, MY_STATS, MEMBERSHIP }

sealed interface LinkRoute {
    data class Tab(val tab: TabTarget, val sessionId: String? = null) : LinkRoute
    data class ChallengeDetail(val id: String) : LinkRoute
    data class NewChallenge(val opponentId: String?) : LinkRoute
    data class CheckIn(val token: String) : LinkRoute
    data class OpenInBrowser(val url: String) : LinkRoute
    data object NotOurs : LinkRoute
}

object LinkRouter {
    // Postgres' uuid shape, either case, as isUuid in challenge-qr.ts.
    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    // CHECKIN_TOKEN_REGEX (packages/shared/src/utils/constants.ts): lower-case only.
    private val CHECKIN_TOKEN = Regex("^[0-9a-f]{48}$")

    fun parse(url: String, siteUrl: String?): LinkRoute {
        if (siteUrl == null) return LinkRoute.NotOurs
        val link = uri(url.trim()) ?: return LinkRoute.NotOurs
        val site = uri(siteUrl) ?: return LinkRoute.NotOurs
        if (!sameOrigin(link, site)) return LinkRoute.NotOurs

        val path = (link.rawPath ?: "").trimEnd('/').ifEmpty { "/" }
        val query = queryParams(link.rawQuery)
        val segments = path.removePrefix("/").split('/')

        return when {
            path == "/leaderboard" -> LinkRoute.Tab(TabTarget.LEADERBOARD)
            path == "/my-stats" -> LinkRoute.Tab(TabTarget.MY_STATS)
            // The web folded the schedule into the feed; /sessions only redirects there.
            path == "/feed" || path == "/sessions" -> LinkRoute.Tab(TabTarget.FEED, query["s"]?.takeIf { UUID.matches(it) })
            path == "/membership" || path == "/fees" -> LinkRoute.Tab(TabTarget.MEMBERSHIP)
            path == "/challenges" -> LinkRoute.Tab(TabTarget.CHALLENGES)
            path == "/challenges/new" -> LinkRoute.NewChallenge(query["opponent"]?.takeIf { UUID.matches(it) })
            segments.size == 2 && segments[0] == "challenges" && UUID.matches(segments[1]) ->
                LinkRoute.ChallengeDetail(segments[1])
            segments.size == 2 && segments[0] == "checkin" && CHECKIN_TOKEN.matches(segments[1]) ->
                LinkRoute.CheckIn(segments[1])
            else -> LinkRoute.OpenInBrowser(url.trim())
        }
    }

    private fun uri(text: String): URI? = try {
        URI(text)
    } catch (e: URISyntaxException) {
        null
    }

    private fun sameOrigin(link: URI, site: URI): Boolean {
        if (!link.scheme.equals("https", ignoreCase = true)) return false
        if (link.rawUserInfo != null) return false
        val host = link.host ?: return false
        if (!host.equals(site.host ?: return false, ignoreCase = true)) return false
        return effectivePort(link) == effectivePort(site)
    }

    private fun effectivePort(u: URI): Int = if (u.port == -1) 443 else u.port

    private fun queryParams(raw: String?): Map<String, String> {
        if (raw.isNullOrEmpty()) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (pair in raw.split('&')) {
            val key = pair.substringBefore('=')
            val value = pair.substringAfter('=', "")
            // The first value wins, as URLSearchParams.get does.
            if (key.isNotEmpty() && key !in out) out[key] = value
        }
        return out
    }
}
