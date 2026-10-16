package com.clubladder.app.shared

// Port of activeSeasonOrFilter in packages/shared/src/utils/active-season.ts.
// Keep in step with it. Season-less rows are included; no active season means
// no filter at all.

fun activeSeasonOrFilter(activeSeasonId: String?): String? {
    if (activeSeasonId.isNullOrEmpty()) return null
    return "season_id.eq.$activeSeasonId,season_id.is.null"
}
