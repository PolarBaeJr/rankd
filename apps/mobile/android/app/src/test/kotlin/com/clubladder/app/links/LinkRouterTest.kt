package com.clubladder.app.links

import org.junit.Assert.assertEquals
import org.junit.Test

class LinkRouterTest {
    private val site = "https://site.example.invalid"
    private val id = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private val token = "a".repeat(48)

    private fun parse(url: String) = LinkRouter.parse(url, site)

    @Test
    fun `routes every claimed tab path`() {
        assertEquals(LinkRoute.Tab(TabTarget.LEADERBOARD), parse("$site/leaderboard"))
        assertEquals(LinkRoute.Tab(TabTarget.MY_STATS), parse("$site/my-stats"))
        assertEquals(LinkRoute.Tab(TabTarget.FEED), parse("$site/feed"))
        assertEquals(LinkRoute.Tab(TabTarget.FEED), parse("$site/sessions"))
        assertEquals(LinkRoute.Tab(TabTarget.MEMBERSHIP), parse("$site/membership"))
        assertEquals(LinkRoute.Tab(TabTarget.MEMBERSHIP), parse("$site/fees"))
        assertEquals(LinkRoute.Tab(TabTarget.CHALLENGES), parse("$site/challenges"))
    }

    @Test
    fun `keeps a session id only when it is a uuid`() {
        assertEquals(LinkRoute.Tab(TabTarget.FEED, id), parse("$site/sessions?s=$id"))
        assertEquals(LinkRoute.Tab(TabTarget.FEED), parse("$site/sessions?s=nope"))
        assertEquals(LinkRoute.Tab(TabTarget.FEED, id), parse("$site/feed?s=$id"))
        assertEquals(LinkRoute.Tab(TabTarget.FEED), parse("$site/feed?s=nope"))
    }

    @Test
    fun `routes challenges`() {
        assertEquals(LinkRoute.ChallengeDetail(id), parse("$site/challenges/$id"))
        assertEquals(LinkRoute.ChallengeDetail(id.uppercase()), parse("$site/challenges/${id.uppercase()}"))
        assertEquals(LinkRoute.NewChallenge(id), parse("$site/challenges/new?opponent=$id"))
        assertEquals(LinkRoute.NewChallenge(null), parse("$site/challenges/new"))
        assertEquals(LinkRoute.NewChallenge(null), parse("$site/challenges/new?opponent=bad"))
        assertEquals(LinkRoute.NewChallenge(id), parse("$site/challenges/new?utm=x&opponent=$id"))
    }

    @Test
    fun `sends a bad challenge id to the browser`() {
        assertEquals(LinkRoute.OpenInBrowser("$site/challenges/not-a-uuid"), parse("$site/challenges/not-a-uuid"))
    }

    @Test
    fun `routes a check-in token only in the website's exact shape`() {
        assertEquals(LinkRoute.CheckIn(token), parse("$site/checkin/$token"))
        assertEquals(LinkRoute.OpenInBrowser("$site/checkin/${"a".repeat(47)}"), parse("$site/checkin/${"a".repeat(47)}"))
        assertEquals(LinkRoute.OpenInBrowser("$site/checkin/${"a".repeat(49)}"), parse("$site/checkin/${"a".repeat(49)}"))
        assertEquals(LinkRoute.OpenInBrowser("$site/checkin/${"A".repeat(48)}"), parse("$site/checkin/${"A".repeat(48)}"))
    }

    @Test
    fun `allows a trailing slash and an upper-case host`() {
        assertEquals(LinkRoute.Tab(TabTarget.LEADERBOARD), parse("$site/leaderboard/"))
        assertEquals(LinkRoute.Tab(TabTarget.LEADERBOARD), parse("https://SITE.example.invalid/leaderboard"))
        assertEquals(LinkRoute.Tab(TabTarget.LEADERBOARD), parse("https://site.example.invalid:443/leaderboard"))
    }

    @Test
    fun `sends other pages of the website to the browser`() {
        assertEquals(LinkRoute.OpenInBrowser("$site/tournaments/checkin"), parse("$site/tournaments/checkin"))
        assertEquals(LinkRoute.OpenInBrowser("$site/notifications"), parse("$site/notifications"))
        assertEquals(LinkRoute.OpenInBrowser(site), parse(site))
    }

    @Test
    fun `refuses anything that is not the website's own origin`() {
        assertEquals(LinkRoute.NotOurs, parse("https://other.example.invalid/leaderboard"))
        assertEquals(LinkRoute.NotOurs, parse("http://site.example.invalid/leaderboard"))
        assertEquals(LinkRoute.NotOurs, parse("https://site.example.invalid:8443/leaderboard"))
        assertEquals(LinkRoute.NotOurs, parse("https://user@site.example.invalid/leaderboard"))
        assertEquals(LinkRoute.NotOurs, parse("https://site.example.invalid.other.example.invalid/leaderboard"))
        assertEquals(LinkRoute.NotOurs, parse("not a url at all"))
        assertEquals(LinkRoute.NotOurs, parse("WIFI:S:club;T:WPA;P:secret;;"))
        assertEquals(LinkRoute.NotOurs, LinkRouter.parse("$site/leaderboard", null))
    }
}
