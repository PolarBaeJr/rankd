import SwiftUI

/// Email then code, or a passkey. Sign-in only: accounts are created on the
/// website, where the waivers are signed, so an unknown address is told so
/// rather than enrolled, and passkeys are added there too. The notice lives in
/// the session manager, not here: a good code or passkey for an unfinished
/// account comes back to a freshly drawn screen. The passkey button shows only
/// when the build names the club website, and hides for the rest of the
/// screen's life once passkeys prove unavailable.
struct SignInScreen: View {
    let services: Services
    let notice: SignInNotice?

    @State private var email = ""
    @State private var code = ""
    @State private var sent = false
    @State private var busy = false
    @State private var error = ""
    @State private var info = ""
    @State private var passkeyOff = false
    @FocusState private var focused: Field?

    private enum Field { case email, code }

    var body: some View {
        ZStack {
            background
            ScrollView {
                card
                    .frame(maxWidth: 432)
                    .padding(16)
                    .frame(maxWidth: .infinity)
                    .containerRelativeFrame(.vertical, alignment: .center) { length, _ in length }
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    // The website's sign-in page: a dark card on a faint red glow.
    private var background: some View {
        GeometryReader { geo in
            ZStack {
                Palette.background
                RadialGradient(
                    colors: [Palette.accent.opacity(0.09), .clear],
                    center: .top,
                    startRadius: 0,
                    endRadius: geo.size.width * 0.9,
                )
                RadialGradient(
                    colors: [Palette.text.opacity(0.05), .clear],
                    center: .bottomTrailing,
                    startRadius: 0,
                    endRadius: geo.size.width * 0.8,
                )
            }
        }
        .ignoresSafeArea()
    }

    private var card: some View {
        VStack(spacing: 22) {
            VStack(spacing: 0) {
                BrandTile(size: 56, corner: 12, markSize: 28)
                Text("Club Ladder".uppercased())
                    .foregroundStyle(Palette.accent)
                    .textStyle(TypeStyle.signinTitle)
                    .padding(.top, 16)
            }
            if !sent {
                emailStep
            } else {
                codeStep
            }
            if let siteUrl = services.siteUrl {
                legal(siteUrl)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 28)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color(hex: 0x40D94444), lineWidth: 1))
        // The web blurs a red glow behind the card.
        .shadow(color: Palette.accent.opacity(0.35), radius: 24)
    }

    @ViewBuilder
    private var emailStep: some View {
        let passkey = passkeyOff ? nil : services.passkey
        VStack(spacing: 0) {
            Eyebrow(text: "WELCOME BACK")
            Text("Sign in")
                .foregroundStyle(Palette.text)
                .textStyle(TypeStyle.signinHeading)
                .padding(.top, 6)
            Text(passkey != nil ? "Use a passkey or a 6-digit code we email you." : "Use a 6-digit code we email you.")
                .foregroundStyle(Palette.muted)
                .textStyle(TypeStyle.pageSub)
                .multilineTextAlignment(.center)
                .padding(.top, 6)
        }
        NoticeFor(notice: notice)

        if let passkey {
            VStack(spacing: 10) {
                GhostButton(title: busy ? "Checking..." : "Sign in with a passkey", enabled: !busy, icon: "key") {
                    handlePasskey(passkey)
                }
                Text("Passkeys are added on the club website, not in this app.")
                    .foregroundStyle(Palette.muted)
                    .textStyle(TypeStyle.body(12, lineHeight: 17))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
            HStack(spacing: 12) {
                Rectangle().fill(Palette.line).frame(height: 1)
                Text("or with email")
                    .foregroundStyle(Palette.muted)
                    .textStyle(TypeStyle.body(14))
                    .fixedSize()
                Rectangle().fill(Palette.line).frame(height: 1)
            }
        }

        VStack(alignment: .leading, spacing: 12) {
            Text("Email".uppercased())
                .foregroundStyle(Palette.muted)
                .textStyle(TextSpec(face: .mono(weight: 400), size: 11, trackingEm: 0.08, relativeTo: .caption))
            HStack(spacing: 12) {
                Image("mail")
                    .renderingMode(.template)
                    .resizable()
                    .frame(width: 16, height: 16)
                    .foregroundStyle(Palette.muted)
                TextField("", text: $email, prompt: Text("you@example.org").foregroundStyle(Palette.placeholder))
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .focused($focused, equals: .email)
                    .onSubmit { if !busy && !isBlank(email) { handleSend() } }
                    .foregroundStyle(busy ? Palette.muted : Palette.text)
                    .textStyle(TypeStyle.body(14))
                    .disabled(busy)
            }
            .fieldBox(focused: focused == .email)
            Messages(info: info, error: error)
            PrimaryButton(title: busy ? "Sending..." : "Email me a code", enabled: !busy && !isBlank(email), icon: "mail") {
                handleSend()
            }
        }

        signUp
    }

    @ViewBuilder
    private var signUp: some View {
        if let siteUrl = services.siteUrl, let url = URL(string: "\(siteUrl)/signup") {
            (Text("New to the club? ").foregroundColor(Palette.muted) + Text(link("Create an account", url, weight: 600)))
                .textStyle(TypeStyle.body(13))
                .multilineTextAlignment(.center)
                .tint(Palette.accent)
                .frame(maxWidth: .infinity)
        } else {
            Text("New to the club? Create an account on the club website.")
                .foregroundStyle(Palette.muted)
                .textStyle(TypeStyle.body(13))
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var codeStep: some View {
        VStack(spacing: 0) {
            Image("mail")
                .renderingMode(.template)
                .resizable()
                .frame(width: 28, height: 28)
                .foregroundStyle(Palette.accent)
                .frame(width: 64, height: 64)
                .background(Palette.highlight, in: Circle())
                .overlay(Circle().strokeBorder(Palette.redBorder, lineWidth: 1))
            Text("Enter your code")
                .foregroundStyle(Palette.text)
                .textStyle(TextSpec(face: .condensed, size: 22, relativeTo: .title3))
                .padding(.top, 14)
            Text("Enter the code we sent to \(trimmed(email)).")
                .foregroundStyle(Palette.muted)
                .textStyle(TypeStyle.body(14, lineHeight: 21))
                .multilineTextAlignment(.center)
                .padding(.top, 6)
        }
        NoticeFor(notice: notice)

        VStack(spacing: 12) {
            TextField(
                "",
                text: Binding(get: { code }, set: { if $0.count <= 10 { code = $0 } }),
                prompt: Text("6-digit code").foregroundStyle(Palette.muted).font(.custom(FontName.barlowRegular, size: 14, relativeTo: .body)),
            )
            .textContentType(.oneTimeCode)
            .keyboardType(.numberPad)
            .multilineTextAlignment(.center)
            .focused($focused, equals: .code)
            .foregroundStyle(busy ? Palette.muted : Palette.text)
            .textStyle(TextSpec(face: .mono(weight: 400), size: 24, trackingEm: 0.4, relativeTo: .title2))
            .disabled(busy)
            .fieldBox(focused: focused == .code)
            Messages(info: info, error: error)
            PrimaryButton(title: busy ? "Checking..." : "Sign in", enabled: !busy && !isBlank(code)) {
                handleVerify()
            }
        }
        HStack(spacing: 0) {
            TextLink(text: "Resend code", enabled: !busy) { handleResend() }
            Text("\u{00B7}")
                .foregroundStyle(Palette.muted)
                .textStyle(TypeStyle.body(12))
                .padding(.horizontal, 10)
            TextLink(text: "Change email", enabled: !busy) {
                sent = false
                code = ""
                error = ""
                info = ""
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func legal(_ siteUrl: String) -> some View {
        var text = AttributedString("By signing in you agree to the ")
        if let terms = URL(string: "\(siteUrl)/legal/terms") { text += link("Terms of Use", terms) }
        text += AttributedString(" and ")
        if let privacy = URL(string: "\(siteUrl)/legal/privacy") { text += link("Privacy Policy", privacy) }
        text += AttributedString(".")
        return Text(text)
            .foregroundStyle(Palette.muted)
            .textStyle(TypeStyle.body(12, lineHeight: 18))
            .multilineTextAlignment(.center)
            .tint(Palette.muted)
            .frame(maxWidth: .infinity)
    }

    private func link(_ text: String, _ url: URL, weight: Int? = nil) -> AttributedString {
        var part = AttributedString(text)
        part.link = url
        part.underlineStyle = .single
        if let weight {
            part.font = .custom(weight >= 600 ? FontName.barlowSemiBold : FontName.barlowRegular, size: 13, relativeTo: .body)
        }
        return part
    }

    // MARK: Actions

    private func send() async -> Bool {
        do {
            switch try await services.emailCode.send(trimmed(email)) {
            case .sent:
                return true
            case .unknownAccount:
                await services.sessions.setNotice(.unknownAccount)
                return false
            case let .failed(message):
                error = message
                return false
            }
        } catch {
            return false
        }
    }

    private func handleSend() {
        Task {
            busy = true
            error = ""
            info = ""
            await services.sessions.setNotice(nil)
            if await send() {
                code = ""
                sent = true
                focused = .code
            }
            busy = false
        }
    }

    private func handleResend() {
        Task {
            busy = true
            error = ""
            info = ""
            if await send() { info = "A new code is on its way." }
            busy = false
        }
    }

    private func handleVerify() {
        Task {
            busy = true
            error = ""
            do {
                switch try await services.emailCode.verify(trimmed(email), trimmed(code)) {
                // The session manager swaps this screen out; nothing to do here.
                case .signedIn:
                    break
                case .unfinished:
                    sent = false
                    code = ""
                    await services.sessions.setNotice(.unfinished)
                case let .failed(message):
                    error = message
                }
            } catch {}
            busy = false
        }
    }

    private func handlePasskey(_ passkey: PasskeySignIn) {
        Task {
            busy = true
            error = ""
            info = ""
            await services.sessions.setNotice(nil)
            do {
                switch try await passkey.signIn(services.authenticator) {
                // The session manager swaps this screen out; nothing to do here.
                case .signedIn:
                    break
                case .unfinished:
                    await services.sessions.setNotice(.unfinished)
                // The member closed the sheet: they know, so nothing is said.
                case .cancelled:
                    break
                case .noPasskey:
                    error = "There is no Club Ladder passkey on this phone. Sign in with an email code, " +
                        "then add a passkey on the club website."
                case .unavailable:
                    passkeyOff = true
                    info = "Passkey sign-in is not available right now. Use an email code."
                case let .failed(message):
                    error = message
                }
            } catch {}
            busy = false
        }
    }
}

// Kotlin's trim() and isBlank().
private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
private func isBlank(_ s: String) -> Bool { trimmed(s).isEmpty }

private struct NoticeFor: View {
    let notice: SignInNotice?

    var body: some View {
        switch notice {
        case .unknownAccount:
            Notice(text: "No account uses that email. Create an account on the club website first.")
        case .unfinished:
            Notice(
                text: "That account has not finished signing up yet. Complete sign-up on the club website, " +
                    "then sign in here.",
            )
        case nil:
            EmptyView()
        }
    }
}

private struct Messages: View {
    let info: String
    let error: String

    var body: some View {
        if !info.isEmpty {
            Text(info)
                .foregroundStyle(Palette.muted)
                .textStyle(TypeStyle.body(13, lineHeight: 19))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        if !error.isEmpty { AlertBox(text: error) }
    }
}

extension View {
    /// The outlined text field: surface fill, a hairline that turns red on focus.
    func fieldBox(focused: Bool) -> some View {
        padding(.horizontal, 16)
            .frame(minHeight: 56)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(focused ? Palette.accent : Palette.line, lineWidth: focused ? 2 : 1),
            )
            .tint(Palette.accent)
    }
}
