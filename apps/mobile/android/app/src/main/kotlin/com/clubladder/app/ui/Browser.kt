package com.clubladder.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.net.toUri

// A club website page the app does not draw opens in the member's browser. The
// app claims some of the website's paths (App Links), so a plain VIEW intent
// for one of them could land straight back here; the intent is pinned to a
// browser package instead, found by asking who opens an unclaimed https URL.

private const val PROBE = "https://example.invalid"

private fun browserPackage(context: Context): String? {
    val pm = context.packageManager
    val probe = Intent(Intent.ACTION_VIEW, PROBE.toUri()).addCategory(Intent.CATEGORY_BROWSABLE)
    val own = context.packageName
    // "android" is the chooser, not a browser.
    fun usable(pkg: String?) = pkg != null && pkg != "android" && pkg != own
    val default = pm.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
    if (usable(default)) return default
    return pm.queryIntentActivities(probe, 0).map { it.activityInfo.packageName }.firstOrNull { usable(it) }
}

/** False when no browser could be found or started; nothing is started then. */
fun openInBrowser(context: Context, url: String): Boolean {
    val pkg = browserPackage(context) ?: return false
    val intent = Intent(Intent.ACTION_VIEW, url.toUri())
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .setPackage(pkg)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
        context.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}

const val NO_BROWSER = "No browser on this phone could open that page."
