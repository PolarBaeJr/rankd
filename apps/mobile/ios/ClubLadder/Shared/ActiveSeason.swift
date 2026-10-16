import Foundation

// Port of activeSeasonOrFilter in packages/shared/src/utils/active-season.ts,
// via ActiveSeason.kt. Keep in step with it. Season-less rows are included; no
// active season means no filter at all.

func activeSeasonOrFilter(_ activeSeasonId: String?) -> String? {
    guard let activeSeasonId, !activeSeasonId.isEmpty else { return nil }
    return "season_id.eq.\(activeSeasonId),season_id.is.null"
}
