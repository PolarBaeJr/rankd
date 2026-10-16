import Foundation

// Port of Features.kt, the flag half of packages/shared/src/utils/features.ts:
// the ids, featureField, the defaults, parseFeatureFlags and featureGate. Keep in
// step with it.
//
// holdsAccess is always false in the app. The web lets a member holding a
// page.access.<id> key see a switched-off feature's card; that needs the
// member's permission columns, which players_self does not carry, and there is
// no app route for it yet. So such a member sees less here than on the web. The
// server still refuses every write, whichever way this reads.

enum FeatureGateDecision: Sendable { case allow, banner, redirect }

/// Every feature id, in the web's order, and whether it is on with no stored value.
let features: [(id: String, defaultOn: Bool)] = [
    ("sessions", true),
    ("challenges", true),
    ("tournaments", true),
    ("events", true),
    ("leaderboard", true),
    ("my_stats", true),
    ("announcements", true),
    ("fees", true),
    ("membership", true),
    ("socials", true),
    ("guest_waivers", false),
]

func featureField(_ id: String) -> String { "\(id)_enabled" }

let defaultFeatureFlags: [String: Bool] = Dictionary(uniqueKeysWithValues: features.map { ($0.id, $0.defaultOn) })

/**
 * The platform_settings 'features' value. A default-on feature is off only for
 * a literal false; a default-off one is on only for a literal true. Anything
 * that is not an object reads as the defaults.
 */
func parseFeatureFlags(_ value: JSONValue?) -> [String: Bool] {
    var flags: [String: Bool] = [:]
    for (id, defaultOn) in features {
        let stored = value?.isObject == true ? value?[featureField(id)]?.bool : nil
        flags[id] = defaultOn ? stored != false : stored == true
    }
    return flags
}

func featureGate(_ enabled: Bool, _ holdsAccess: Bool) -> FeatureGateDecision {
    if enabled { return .allow }
    return holdsAccess ? .banner : .redirect
}

/// The web's on(id), with no access keys (see the header).
func featureOn(_ flags: [String: Bool], _ id: String) -> Bool {
    featureGate(flags[id] ?? defaultFeatureFlags[id] ?? true, false) != .redirect
}
