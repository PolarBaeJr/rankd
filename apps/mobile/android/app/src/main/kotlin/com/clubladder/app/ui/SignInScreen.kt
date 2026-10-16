package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.clubladder.app.R
import com.clubladder.app.Services
import com.clubladder.app.auth.CredentialManagerAuthenticator
import com.clubladder.app.auth.PasskeySignIn
import com.clubladder.app.auth.PasskeySignInResult
import com.clubladder.app.auth.SendCodeResult
import com.clubladder.app.auth.SignInNotice
import com.clubladder.app.auth.VerifyCodeResult
import com.clubladder.app.ui.theme.Barlow
import com.clubladder.app.ui.theme.BarlowCondensed
import com.clubladder.app.ui.theme.JetBrainsMono
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type
import kotlinx.coroutines.launch

/**
 * Email then code, or a passkey. Sign-in only: accounts are created on the
 * website, where the waivers are signed, so an unknown address is told so
 * rather than enrolled, and passkeys are added there too. The notice lives in
 * the session manager, not here: a good code or passkey for an unfinished
 * account comes back to a freshly composed screen. The passkey button shows
 * only when the build names the club website, and hides for the rest of the
 * screen's life once passkeys prove unavailable.
 */
@Composable
fun SignInScreen(services: Services, notice: SignInNotice?) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    var email by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var sent by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf("") }
    var info by rememberSaveable { mutableStateOf("") }
    var passkeyOff by rememberSaveable { mutableStateOf(false) }
    // LocalContext here is the Activity, which Credential Manager needs to show
    // its sheet over; the application context would fail.
    val context = LocalContext.current
    val authenticator = remember(context) { CredentialManagerAuthenticator(context) }

    suspend fun send(): Boolean = when (val result = services.emailCode.send(email.trim())) {
        SendCodeResult.Sent -> true
        SendCodeResult.UnknownAccount -> {
            services.sessions.setNotice(SignInNotice.UNKNOWN_ACCOUNT)
            false
        }
        is SendCodeResult.Failed -> {
            error = result.message
            false
        }
    }

    fun handleSend() = scope.launch {
        busy = true
        error = ""
        info = ""
        services.sessions.setNotice(null)
        if (send()) {
            code = ""
            sent = true
        }
        busy = false
    }

    fun handleResend() = scope.launch {
        busy = true
        error = ""
        info = ""
        if (send()) info = "A new code is on its way."
        busy = false
    }

    fun handleVerify() = scope.launch {
        busy = true
        error = ""
        when (val result = services.emailCode.verify(email.trim(), code.trim())) {
            // The session manager swaps this screen out; nothing to do here.
            VerifyCodeResult.SignedIn -> Unit
            VerifyCodeResult.Unfinished -> {
                sent = false
                code = ""
                services.sessions.setNotice(SignInNotice.UNFINISHED)
            }
            is VerifyCodeResult.Failed -> error = result.message
        }
        busy = false
    }

    fun handlePasskey(passkey: PasskeySignIn) = scope.launch {
        busy = true
        error = ""
        info = ""
        services.sessions.setNotice(null)
        when (val result = passkey.signIn(authenticator)) {
            // The session manager swaps this screen out; nothing to do here.
            PasskeySignInResult.SignedIn -> Unit
            PasskeySignInResult.Unfinished -> services.sessions.setNotice(SignInNotice.UNFINISHED)
            // The member closed the sheet: they know, so nothing is said.
            PasskeySignInResult.Cancelled -> Unit
            PasskeySignInResult.NoPasskey ->
                error = "There is no Club Ladder passkey on this phone. Sign in with an email code, " +
                    "then add a passkey on the club website."
            PasskeySignInResult.Unavailable -> {
                passkeyOff = true
                info = "Passkey sign-in is not available right now. Use an email code."
            }
            is PasskeySignInResult.Failed -> error = result.message
        }
        busy = false
    }

    val siteUrl = services.siteUrl
    val uriHandler = LocalUriHandler.current
    // A phone with no browser leaves a link doing nothing rather than crashing.
    val open: (String) -> Unit = { url -> runCatching { uriHandler.openUri(url) } }
    val linkStyle = SpanStyle(color = p.muted, textDecoration = TextDecoration.Underline)
    val signUpStyle = linkStyle.copy(color = p.accent, fontWeight = FontWeight.SemiBold)
    // The website's sign-in page: a dark card on a faint red glow.
    Box(
        Modifier
            .fillMaxSize()
            .background(p.background)
            .drawBehind {
                drawRect(
                    Brush.radialGradient(
                        listOf(p.accent.copy(alpha = 0.09f), Color.Transparent),
                        center = Offset(size.width / 2, 0f),
                        radius = size.width * 0.9f,
                    ),
                )
                drawRect(
                    Brush.radialGradient(
                        listOf(p.text.copy(alpha = 0.05f), Color.Transparent),
                        center = Offset(size.width, size.height),
                        radius = size.width * 0.8f,
                    ),
                )
            },
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(Modifier.widthIn(max = 432.dp).fillMaxWidth()) {
                Column(
                    Modifier
                        .padding(16.dp)
                        .fillMaxWidth()
                        // The web blurs a red glow behind the card; Modifier.blur
                        // needs Android 12, so a red-tinted shadow stands in.
                        .shadow(
                            24.dp,
                            RoundedCornerShape(16.dp),
                            ambientColor = p.accent,
                            spotColor = p.accent,
                        )
                        .background(p.surface, RoundedCornerShape(16.dp))
                        .border(1.dp, Color(0x40D94444), RoundedCornerShape(16.dp))
                        .padding(horizontal = 24.dp, vertical = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(22.dp),
                ) {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        BrandTile(size = 56.dp, corner = 12.dp, markSize = 28.dp)
                        Spacer(Modifier.height(16.dp))
                        Text("Club Ladder".uppercase(), color = p.accent, style = Type.signinTitle)
                    }

                    if (!sent) {
                        val passkey = services.passkey?.takeIf { !passkeyOff }
                        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.size(width = 24.dp, height = 2.dp).background(p.accent))
                                Spacer(Modifier.width(8.dp))
                                Text("WELCOME BACK", color = p.accent, style = Type.pageEyebrow)
                            }
                            Text(
                                "Sign in",
                                color = p.text,
                                style = Type.signinHeading,
                                modifier = Modifier.padding(top = 6.dp),
                            )
                            Text(
                                if (passkey != null) {
                                    "Use a passkey or a 6-digit code we email you."
                                } else {
                                    "Use a 6-digit code we email you."
                                },
                                color = p.muted,
                                style = Type.pageSub,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.padding(top = 6.dp),
                            )
                        }
                        NoticeFor(notice)

                        if (passkey != null) {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                GhostButton(
                                    if (busy) "Checking..." else "Sign in with a passkey",
                                    enabled = !busy,
                                    icon = R.drawable.ic_key,
                                ) {
                                    handlePasskey(passkey)
                                }
                                Text(
                                    "Passkeys are added on the club website, not in this app.",
                                    color = p.muted,
                                    fontSize = 12.sp,
                                    lineHeight = 17.sp,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                HorizontalDivider(Modifier.weight(1f), color = p.line)
                                Text(
                                    "or with email",
                                    color = p.muted,
                                    fontSize = 14.sp,
                                    modifier = Modifier.padding(horizontal = 12.dp),
                                )
                                HorizontalDivider(Modifier.weight(1f), color = p.line)
                            }
                        }

                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(
                                "Email".uppercase(),
                                color = p.muted,
                                fontFamily = JetBrainsMono,
                                fontSize = 11.sp,
                                letterSpacing = 0.08.em,
                            )
                            OutlinedTextField(
                                value = email,
                                onValueChange = { email = it },
                                placeholder = { Text("you@example.org", color = p.placeholder, fontSize = 14.sp) },
                                leadingIcon = {
                                    Icon(
                                        painterResource(R.drawable.ic_mail),
                                        contentDescription = null,
                                        tint = p.muted,
                                        modifier = Modifier.size(16.dp),
                                    )
                                },
                                singleLine = true,
                                enabled = !busy,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                                textStyle = TextStyle(fontFamily = Barlow, fontSize = 14.sp),
                                shape = RoundedCornerShape(8.dp),
                                colors = fieldColors(),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Messages(info, error)
                            PrimaryButton(
                                if (busy) "Sending..." else "Email me a code",
                                enabled = !busy && email.isNotBlank(),
                                icon = R.drawable.ic_mail,
                            ) {
                                handleSend()
                            }
                        }

                        val signUp = if (siteUrl != null) {
                            buildAnnotatedString {
                                append("New to the club? ")
                                link("Create an account", "$siteUrl/signup", signUpStyle, open)
                            }
                        } else {
                            AnnotatedString("New to the club? Create an account on the club website.")
                        }
                        Text(
                            signUp,
                            color = p.muted,
                            fontSize = 13.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(
                                Modifier
                                    .size(64.dp)
                                    .background(p.highlight, CircleShape)
                                    .border(1.dp, p.redBorder, CircleShape),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    painterResource(R.drawable.ic_mail),
                                    contentDescription = null,
                                    tint = p.accent,
                                    modifier = Modifier.size(28.dp),
                                )
                            }
                            Text(
                                "Enter your code",
                                color = p.text,
                                fontFamily = BarlowCondensed,
                                fontWeight = FontWeight.Bold,
                                fontSize = 22.sp,
                                modifier = Modifier.padding(top = 14.dp),
                            )
                            Text(
                                "Enter the code we sent to ${email.trim()}.",
                                color = p.muted,
                                fontSize = 14.sp,
                                lineHeight = 21.sp,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.padding(top = 6.dp),
                            )
                        }
                        NoticeFor(notice)

                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            OutlinedTextField(
                                value = code,
                                onValueChange = { if (it.length <= 10) code = it },
                                placeholder = {
                                    Text(
                                        "6-digit code",
                                        color = p.muted,
                                        fontFamily = Barlow,
                                        fontSize = 14.sp,
                                        textAlign = TextAlign.Center,
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                },
                                singleLine = true,
                                enabled = !busy,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                                textStyle = TextStyle(
                                    fontFamily = JetBrainsMono,
                                    fontSize = 24.sp,
                                    letterSpacing = 0.4.em,
                                    textAlign = TextAlign.Center,
                                ),
                                shape = RoundedCornerShape(8.dp),
                                colors = fieldColors(),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Messages(info, error)
                            PrimaryButton(if (busy) "Checking..." else "Sign in", enabled = !busy && code.isNotBlank()) {
                                handleVerify()
                            }
                        }
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            TextLink("Resend code", enabled = !busy) { handleResend() }
                            Text("\u00B7", color = p.muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 10.dp))
                            TextLink("Change email", enabled = !busy) {
                                sent = false
                                code = ""
                                error = ""
                                info = ""
                            }
                        }
                    }

                    if (siteUrl != null) {
                        Text(
                            buildAnnotatedString {
                                append("By signing in you agree to the ")
                                link("Terms of Use", "$siteUrl/legal/terms", linkStyle, open)
                                append(" and ")
                                link("Privacy Policy", "$siteUrl/legal/privacy", linkStyle, open)
                                append(".")
                            },
                            color = p.muted,
                            fontSize = 12.sp,
                            lineHeight = 18.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun NoticeFor(notice: SignInNotice?) {
    when (notice) {
        SignInNotice.UNKNOWN_ACCOUNT ->
            Notice("No account uses that email. Create an account on the club website first.")
        SignInNotice.UNFINISHED ->
            Notice(
                "That account has not finished signing up yet. Complete sign-up on the club website, " +
                    "then sign in here.",
            )
        null -> Unit
    }
}

@Composable
private fun Messages(info: String, error: String) {
    if (info.isNotEmpty()) Text(info, color = LocalPalette.current.muted, fontSize = 13.sp, lineHeight = 19.sp)
    if (error.isNotEmpty()) Alert(error)
}

@Composable
private fun fieldColors() = LocalPalette.current.let { p ->
    OutlinedTextFieldDefaults.colors(
        focusedTextColor = p.text,
        unfocusedTextColor = p.text,
        disabledTextColor = p.muted,
        focusedContainerColor = p.surface,
        unfocusedContainerColor = p.surface,
        disabledContainerColor = p.surface,
        focusedBorderColor = p.accent,
        unfocusedBorderColor = p.line,
        disabledBorderColor = p.line,
        cursorColor = p.accent,
    )
}

private fun AnnotatedString.Builder.link(text: String, url: String, style: SpanStyle, open: (String) -> Unit) {
    withLink(LinkAnnotation.Clickable(url, TextLinkStyles(style)) { open(url) }) { append(text) }
}
