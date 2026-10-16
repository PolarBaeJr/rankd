import Foundation

/// The configured app: built once per process, so one session has one owner.
final class Services: Sendable {
    let siteUrl: String?
    let sessions: SessionManager
    let postgrest: Postgrest
    let emailCode: EmailCode
    let store: KeychainSessionStore
    /// Nil when the build names no club website: the sign-in screen then offers email codes only.
    let passkey: PasskeySignIn?
    /// Nil when the build names no club website: challenges are then read-only.
    let appApi: AppApi?
    let authenticator: PasskeyAuthenticator

    init(url: String, anonKey: String, siteUrl: String?, rpId: String?) {
        let transport = URLSessionTransport()
        let clock: @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) }
        let gotrue = GoTrueApi(url: url, anonKey: anonKey, transport: transport, nowEpochSec: clock)
        let store = KeychainSessionStore()
        let sessions = SessionManager(api: gotrue, store: store, nowEpochSec: clock)
        let postgrest = Postgrest(url: url, anonKey: anonKey, transport: transport, sessions: sessions)
        self.store = store
        self.sessions = sessions
        self.postgrest = postgrest
        emailCode = EmailCode(api: gotrue, sessions: sessions, postgrest: postgrest)
        self.siteUrl = siteUrl
        passkey = siteUrl.map {
            PasskeySignIn(api: PasskeyApi(siteUrl: $0, transport: transport), gotrue: gotrue, sessions: sessions, postgrest: postgrest, nowEpochSec: clock)
        }
        appApi = siteUrl.map { AppApi(siteUrl: $0, transport: transport, sessions: sessions) }
        authenticator = ASAuthorizationAuthenticator(fallbackRpId: rpId)
    }
}

@MainActor
final class AppContainer {
    let config: SupabaseConfig

    /// Nil when the build has no usable config; the app then shows the config screen.
    let services: Services?

    init() {
        config = SupabaseConfig.read(url: BuildConfig.supabaseUrl, anonKey: BuildConfig.supabaseAnonKey)
        if case let .ok(url, anonKey) = config {
            let rpId = BuildConfig.passkeyRpId?.trimmingCharacters(in: .whitespacesAndNewlines)
            services = Services(url: url, anonKey: anonKey, siteUrl: SiteConfig.read(BuildConfig.siteUrl), rpId: rpId?.isEmpty == false ? rpId : nil)
        } else {
            services = nil
        }
    }
}
