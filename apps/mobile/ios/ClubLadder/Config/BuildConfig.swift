import Foundation

/// The values Config/Local.xcconfig put into Info.plist. An empty address
/// arrives as a bare "https://", which the config readers refuse as missing.
enum BuildConfig {
    static var supabaseUrl: String? { string("BadmintonSupabaseURL") }
    static var supabaseAnonKey: String? { string("BadmintonSupabaseAnonKey") }
    static var siteUrl: String? { string("BadmintonSiteURL") }
    static var passkeyRpId: String? { string("BadmintonPasskeyRpId") }

    private static func string(_ key: String) -> String? {
        Bundle.main.object(forInfoDictionaryKey: key) as? String
    }
}
