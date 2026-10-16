import SwiftUI

// Port of NewChallengeScreen.kt (apps/player/src/app/challenges/new/new-challenge-client.tsx).
// The form builds the same createChallenge input the web form builds and sends
// it through the website. v1 offers "1 game" and "Best of 3" only (a longer
// match cannot have its result submitted), leaves out the Elo preview, and has
// no date or time picker: the website accepts a challenge without one.

let staleOpponent = "That player can't be challenged right now."

private enum Slot: String, Identifiable {
    case opponent, partner, opponentPartner

    var id: String { rawValue }

    var title: String {
        switch self {
        case .opponent: return "Opponent"
        case .partner: return "Partner"
        case .opponentPartner: return "Their partner"
        }
    }

    var placeholder: String {
        switch self {
        case .opponent: return "Search for an opponent..."
        case .partner: return "Search for a partner..."
        case .opponentPartner: return "Search..."
        }
    }
}

struct NewChallengeScreen: View {
    let data: ScreenData
    let viewer: Viewer
    let initialOpponentId: String?
    let onSent: () -> Void
    @State private var loader: Loader<AppResult<ChallengeContext>?>

    init(data: ScreenData, viewer: Viewer, initialOpponentId: String?, onSent: @escaping () -> Void) {
        self.data = data
        self.viewer = viewer
        self.initialOpponentId = initialOpponentId
        self.onSent = onSent
        let context = data.context
        _loader = State(initialValue: Loader { try await loadContext(context) })
    }

    var body: some View {
        Group {
            switch loader.state {
            case .loading: LoadingView()
            case let .failed(message): ErrorState(message: message) { loader.load() }
            case let .loaded(context):
                NewChallengeFormView(data: data, viewer: viewer, context: context, initialOpponentId: initialOpponentId, onSent: onSent)
            }
        }
        .task(id: viewer.id) { loader.load() }
        .onDisappear { loader.cancel() }
    }
}

private struct NewChallengeFormView: View {
    let data: ScreenData
    let viewer: Viewer
    let context: AppResult<ChallengeContext>?
    let onSent: () -> Void

    @State private var type = "singles"
    @State private var games = "3"
    @State private var points = "21"
    @State private var rated = true
    @State private var opponentId: String
    @State private var partnerId = ""
    @State private var opponentPartnerId = ""
    @State private var note = ""
    @State private var picking: Slot?
    @State private var scanning = false
    @State private var sending = false
    @State private var error: String?
    @State private var staleChecked = false

    init(data: ScreenData, viewer: Viewer, context: AppResult<ChallengeContext>?, initialOpponentId: String?, onSent: @escaping () -> Void) {
        self.data = data
        self.viewer = viewer
        self.context = context
        self.onSent = onSent
        _opponentId = State(initialValue: initialOpponentId ?? "")
        #if DEBUG
        _picking = State(initialValue: DebugPreview.picker ? .opponent : nil)
        #endif
    }

    private var ctx: ChallengeContext? { if case let .ok(value)? = context { value } else { nil } }
    private var opponents: [Opponent] { ctx?.opponents ?? [] }
    private var canWrite: Bool { data.action != nil && ctx?.canIssue == true }

    private func byId(_ id: String) -> Opponent? { opponents.first { $0.id == id } }
    private func elo(_ o: Opponent) -> String? { eloText(type == "singles" ? o.singlesElo : o.doublesElo) }
    private func available(_ current: String) -> [Opponent] {
        opponents.filter { $0.id == current || ![opponentId, partnerId, opponentPartnerId].contains($0.id) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PageHeader(title: "New challenge", eyebrow: "Create", padding: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0))
                status
                if let error { AlertBox(text: error) }
                Card {
                    VStack(alignment: .leading, spacing: 18) {
                        VStack(alignment: .leading, spacing: 0) {
                            SectionLabel(text: "Match type")
                            HStack(spacing: 8) {
                                ForEach(["singles", "doubles"], id: \.self) { t in
                                    Choice(text: t.prefix(1).uppercased() + t.dropFirst(), selected: type == t, tint: Palette.accent) { type = t }
                                }
                            }
                        }
                        if type == "doubles" {
                            VStack(alignment: .leading, spacing: 0) {
                                SectionLabel(text: "Your side")
                                Text(viewer.fullName ?? "You")
                                    .foregroundStyle(Palette.ink2)
                                    .textStyle(TypeStyle.body(14))
                                    .padding(.horizontal, 12)
                                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.line, lineWidth: 1))
                            }
                            slot(.partner, partnerId)
                            SectionLabel(text: "Opponents").padding(.bottom, -8)
                            slot(.opponent, opponentId)
                            slot(.opponentPartner, opponentPartnerId)
                        } else {
                            slot(.opponent, opponentId)
                        }
                        GhostButton(title: "Scan their QR", enabled: ctx != nil && data.siteUrl != nil, icon: "scan") { scanning = true }

                        VStack(alignment: .leading, spacing: 0) {
                            SectionLabel(text: "Best of (games)")
                            HStack(spacing: 8) {
                                Choice(text: "1 game", selected: games == "1", tint: Palette.accent) { games = "1" }
                                Choice(text: "Best of 3", selected: games == "3", tint: Palette.accent) { games = "3" }
                            }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            SectionLabel(text: "Points per game")
                            TextField("", text: Binding(get: { points }, set: { points = String($0.filter { ("0"..."9").contains($0) }.prefix(2)) }), prompt: Text("21").foregroundStyle(Palette.placeholder))
                                .keyboardType(.numberPad)
                                .foregroundStyle(Palette.text)
                                .textStyle(TypeStyle.body(14))
                                .fieldBox(focused: pointsInvalid(points))
                            Text(pointsHelper(points))
                                .foregroundStyle(pointsInvalid(points) ? Palette.danger : Palette.muted)
                                .textStyle(TypeStyle.body(12))
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            SectionLabel(text: "Rating impact")
                            Choice(text: rated ? "Rated match" : "Casual (no Elo change)", selected: rated, tint: Palette.gold) { rated.toggle() }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            SectionLabel(text: "Note (optional)")
                            TextField("", text: Binding(get: { note }, set: { note = capUtf16($0, noteMax) }), prompt: Text("Any message for your opponent...").foregroundStyle(Palette.placeholder), axis: .vertical)
                                .lineLimit(3...8)
                                .foregroundStyle(Palette.text)
                                .textStyle(TypeStyle.body(14))
                                .padding(.vertical, 12)
                                .fieldBox(focused: false)
                            Text("\(note.utf16.count) / \(noteMax)").foregroundStyle(Palette.muted).textStyle(TypeStyle.body(12))
                        }
                        PrimaryButton(title: sending ? "Sending..." : "Send challenge", enabled: canWrite && !sending && !pointsInvalid(points)) { send() }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear(perform: checkStale)
        .sheet(item: $picking) { slot in
            let current = value(slot)
            PlayerPickerSheet(
                title: slot.title,
                players: available(current),
                trailing: elo,
                allowClear: !current.isEmpty,
                onPick: { picked in
                    set(slot, picked?.id ?? "")
                    picking = nil
                },
                onDismiss: { picking = nil },
            )
        }
        .fullScreenCover(isPresented: $scanning) {
            ScannerView { outcome in
                scanning = false
                scanned(outcome)
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        if let ctx {
            if !ctx.featureOn {
                Notice(text: ctx.featureMessage ?? "The club has switched challenges off for now.")
            } else if !ctx.standing.ok {
                Card {
                    Text("New challenges paused").foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                    Text(ctx.standing.detail).foregroundStyle(Palette.muted).textStyle(TypeStyle.cardSub).padding(.top, 4)
                }
            } else if ctx.quota.full {
                Notice(text: quotaFullNote(ctx))
            }
        } else {
            if case let .failed(message)? = context { Notice(text: message) } else { Notice(text: readOnlyNotice) }
        }
    }

    private func slot(_ slot: Slot, _ id: String) -> some View {
        let selected = byId(id)
        return PlayerSlot(label: slot.title, selected: selected, trailing: selected.flatMap(elo), placeholder: slot.placeholder) { picking = slot }
    }

    private func value(_ slot: Slot) -> String {
        switch slot {
        case .opponent: return opponentId
        case .partner: return partnerId
        case .opponentPartner: return opponentPartnerId
        }
    }

    private func set(_ slot: Slot, _ id: String) {
        switch slot {
        case .opponent: opponentId = id
        case .partner: partnerId = id
        case .opponentPartner: opponentPartnerId = id
        }
    }

    /// A prefilled opponent the website will not let this member challenge
    /// (out of range, themselves, gone) is cleared, and the form says why.
    /// Only once the list is known: with no context there is nothing to judge by.
    private func checkStale() {
        guard ctx != nil, !staleChecked else { return }
        staleChecked = true
        if !opponentId.isEmpty && byId(opponentId) == nil {
            opponentId = ""
            error = staleOpponent
        }
    }

    private func scanned(_ outcome: ScanOutcome) {
        switch outcome {
        case .cancelled:
            return
        case .unavailable:
            error = scanUnavailable
        case let .scanned(text):
            let route = LinkRouter.parse(text, siteUrl: data.siteUrl)
            let scannedId: String? = if case let .newChallenge(id) = route { id } else { nil }
            if route == .notOurs {
                error = scanNotOurs
            } else if let scannedId {
                if byId(scannedId) == nil {
                    error = staleOpponent
                } else {
                    if partnerId == scannedId { partnerId = "" }
                    if opponentPartnerId == scannedId { opponentPartnerId = "" }
                    opponentId = scannedId
                    error = nil
                }
            } else {
                error = "This is not a member's challenge QR."
            }
        }
    }

    private func send() {
        let built = createChallengeArgs(NewChallengeForm(
            type: type, rated: rated, games: games, points: points, opponentId: opponentId,
            partnerId: partnerId, opponentPartnerId: opponentPartnerId, note: note,
        ))
        switch built {
        case let .invalid(message):
            error = message
        case let .args(name, args):
            guard let action = data.action else { return }
            sending = true
            error = nil
            Task {
                guard let outcome = try? await runAction(action, name, args) else { return }
                switch outcome {
                case .ok:
                    onSent()
                case let .refused(message), let .failed(message):
                    error = message
                    sending = false
                }
            }
        }
    }
}

/// The text cut to `max` UTF-16 units, as a web input's maxLength counts.
func capUtf16(_ text: String, _ max: Int) -> String {
    var out = text
    while out.utf16.count > max { out.removeLast() }
    return out
}

/// The web's toggle buttons: tinted when on, quiet when off.
private struct Choice: View {
    let text: String
    let selected: Bool
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text)
                .foregroundStyle(selected ? tint : Palette.muted)
                .textStyle(TypeStyle.body(14, weight: 700))
                .multilineTextAlignment(.center)
                .padding(12)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(selected ? tint.opacity(0.12) : Palette.surface2, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? tint.opacity(0.35) : Palette.line, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}
