package com.clubladder.app

import android.content.Context
import com.clubladder.app.auth.EmailCode
import com.clubladder.app.auth.FileSessionStore
import com.clubladder.app.auth.GoTrueApi
import com.clubladder.app.auth.KeystoreSessionCipher
import com.clubladder.app.auth.PasskeyApi
import com.clubladder.app.auth.PasskeySignIn
import com.clubladder.app.auth.SessionManager
import com.clubladder.app.config.SiteConfig
import com.clubladder.app.config.SupabaseConfig
import com.clubladder.app.data.AppApi
import com.clubladder.app.data.Postgrest
import com.clubladder.app.net.UrlConnectionTransport
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

/** The configured app: built once per process, so one session has one owner. */
class Services(context: Context, config: SupabaseConfig.Ok, val siteUrl: String?) {
    private val transport = UrlConnectionTransport()
    private val clock = { System.currentTimeMillis() / 1000 }
    private val gotrue = GoTrueApi(config, transport, clock)
    val sessions = SessionManager(
        gotrue,
        FileSessionStore(File(context.filesDir, "session.bin"), KeystoreSessionCipher()),
        clock,
    )
    val postgrest = Postgrest(config, transport, sessions)
    val emailCode = EmailCode(gotrue, sessions, postgrest)

    /** Null when the build names no club website: the sign-in screen then offers email codes only. */
    val passkey: PasskeySignIn? = siteUrl?.let { PasskeySignIn(PasskeyApi(it, transport), gotrue, sessions, postgrest, clock) }

    /** Null with no club website: the app then reads but cannot write. */
    val appApi: AppApi? = siteUrl?.let { AppApi(it, transport, sessions) }
}

class AppContainer(context: Context) {
    val config: SupabaseConfig = SupabaseConfig.read(BuildConfig.SUPABASE_URL, BuildConfig.SUPABASE_ANON_KEY)

    /** Null when the build has no usable config; the app then shows the config screen. */
    val services: Services? = (config as? SupabaseConfig.Ok)?.let {
        Services(context.applicationContext, it, SiteConfig.read(BuildConfig.SITE_URL))
    }

    /**
     * A club website URL Android handed the app (an App Link), waiting to be
     * routed. It stays here while signed out and is routed after sign-in.
     */
    val pendingLink = MutableStateFlow<String?>(null)
}
