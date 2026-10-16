import SwiftUI

// Port of ChallengeDetailScreen.kt (apps/player/src/app/challenges/[id]/page.tsx
// and its actions.tsx). Which buttons show, and when, follows actions.tsx line
// for line; every button runs the website's own action through AppApi. A button
// stays busy from the tap until the reload lands, so a second tap never reaches
// a challenge that has already moved on.

struct DetailData: Sendable {
    let found: ChallengeWithMatch?
    let context: AppResult<ChallengeContext>?
}

enum DetailDialog: String, Identifiable {
    case submit, dispute, walkover

    var id: String { rawValue }
}

struct ChallengeDetailScreen: View {
    let data: ScreenData
    let viewer: Viewer
    let challengeId: String
    @State private var loader: Loader<DetailData>
    @Environment(\.scenePhase) private var scenePhase

    init(data: ScreenData, viewer: Viewer, challengeId: String) {
        self.data = data
        self.viewer = viewer
        self.challengeId = challengeId
        let load = data.challenge
        let context = data.context
        let viewerId = viewer.id
        _loader = State(initialValue: Loader {
            async let found = load(challengeId, viewerId)
            async let ctx = loadContext(context)
            return DetailData(found: try await found, context: try await ctx)
        })
    }

    var body: some View {
        Group {
            switch loader.state {
            case .loading:
                LoadingView()
            case let .failed(message):
                ErrorState(message: message) { loader.load() }
            case let .loaded(detail):
                if let found = detail.found {
                    ScrollView {
                        VStack(spacing: 16) {
                            ChallengeBody(found: found)
                            DetailActions(
                                action: data.action,
                                viewer: viewer,
                                found: found,
                                context: detail.context,
                                refreshing: loader.refreshing,
                            ) { loader.load() }
                        }
                        .padding(16)
                    }
                    .refreshable { await loader.refresh() }
                } else {
                    ErrorState(message: "This challenge is not one of yours, or it no longer exists.")
                }
            }
        }
        .task(id: challengeId) { loader.load() }
        .onDisappear { loader.cancel() }
        // No realtime here: the screen reads again whenever the app comes back
        // to the front.
        .onChange(of: scenePhase) { old, phase in
            if phase == .active && old != .active { loader.load() }
        }
    }
}

private struct ChallengeBody: View {
    let found: ChallengeWithMatch

    var body: some View {
        let c = found.challenge
        Card(padding: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Eyebrow(text: "Challenge")
                    Text(c.type == "singles" ? "Singles match" : "Doubles match")
                        .foregroundStyle(Palette.text)
                        .textStyle(TextSpec(face: .condensed, size: 28, relativeTo: .title))
                }
                Spacer()
                ToneTag(text: c.status.replacingOccurrences(of: "_", with: " "), tone: challengeStatusTone[c.status] ?? .plain)
            }
            .padding(EdgeInsets(top: 20, leading: 20, bottom: 16, trailing: 20))
            Rectangle().fill(Palette.line).frame(height: 1)
            VStack(spacing: 16) {
                let info = [
                    ("TYPE", c.type.prefix(1).uppercased() + c.type.dropFirst()),
                    ("FORMAT", shapeLabel(c.format, c.gamesPerMatch, c.pointsPerGame)),
                    ("RATED", c.ratedFlag ? "Rated" : "Casual"),
                    ("CREATED", formatRelativeTime(c.createdAt)),
                ]
                ForEach([0, 2], id: \.self) { start in
                    HStack(spacing: 10) {
                        InfoBox(label: info[start].0, value: info[start].1)
                        InfoBox(label: info[start + 1].0, value: info[start + 1].1)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                if let note = c.note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(note)
                        .foregroundStyle(Palette.ink2)
                        .textStyle(TypeStyle.body(13, lineHeight: 21))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line, lineWidth: 1))
                }
                TeamBox(label: "TEAM A", players: c.participants.filter { $0.teamSide == "a" })
                TeamBox(label: "TEAM B", players: c.participants.filter { $0.teamSide == "b" })
                if let match = found.match { MatchResultBox(match: match) }
            }
            .padding(20)
        }
    }
}

private struct InfoBox: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).foregroundStyle(Palette.muted).textStyle(TypeStyle.statLabel)
            Text(value).foregroundStyle(Palette.text).textStyle(TypeStyle.body(14, weight: 600))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(14)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line, lineWidth: 1))
    }
}

private struct TeamBox: View {
    let label: String
    let players: [ChallengeParticipant]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).foregroundStyle(Palette.muted).textStyle(TypeStyle.statLabel).padding(.bottom, 2)
            if players.isEmpty {
                Text("No players yet.").foregroundStyle(Palette.muted).textStyle(TypeStyle.body(12))
            }
            ForEach(players, id: \.id) { cp in
                let person = cp.person
                let status = cp.confirmationStatus ?? ""
                HStack(spacing: 10) {
                    Avatar(name: person?.fullName ?? "?", seed: person?.id ?? cp.id, size: .sm)
                    Text(person?.fullName ?? "Unknown")
                        .foregroundStyle(Palette.text)
                        .textStyle(TypeStyle.body(13))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ToneTag(text: status, tone: participantConfirmTone[status] ?? .plain)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line, lineWidth: 1))
    }
}

/// A delta as JavaScript prints a number: "+12", "-3.5", never "12.0".
func signedDelta(_ delta: Double) -> String {
    let text = delta == delta.rounded(.down) && delta.isFinite ? String(Int64(delta)) : String(delta)
    return delta >= 0 ? "+\(text)" : text
}

private struct MatchResultBox: View {
    let match: ChallengeMatch

    var body: some View {
        let status = match.resultStatus ?? ""
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("MATCH RESULT").foregroundStyle(Palette.muted).textStyle(TypeStyle.statLabel)
                Spacer()
                ToneTag(text: status, tone: status == "confirmed" ? .win : status == "disputed" ? .red : .gold)
            }
            .padding(.bottom, 12)
            Text(match.scoreSummary.flatMap { $0.isEmpty ? nil : $0 } ?? "Pending")
                .foregroundStyle(Palette.text)
                .textStyle(TextSpec(face: .condensed, size: 32, relativeTo: .title))
            if !match.games.isEmpty {
                FlowRow(spacing: 12, lineSpacing: 4) {
                    ForEach(match.games.sorted { $0.gameNumber < $1.gameNumber }, id: \.gameNumber) { g in
                        Text("G\(g.gameNumber) \(g.sideAScore)-\(g.sideBScore)")
                            .foregroundStyle(Palette.muted)
                            .textStyle(TextSpec(face: .mono(weight: 400), size: 12, relativeTo: .caption))
                    }
                }
                .padding(.top, 8)
            }
            if !match.participants.isEmpty {
                Rectangle().fill(Palette.line).frame(height: 1).padding(.top, 14)
                VStack(spacing: 6) {
                    ForEach(Array(match.participants.enumerated()), id: \.offset) { _, mp in
                        HStack {
                            Text(mp.person?.fullName ?? "Unknown").foregroundStyle(Palette.text).textStyle(TypeStyle.body(13))
                            Spacer()
                            Text(mp.ratingDelta.map(signedDelta) ?? "pending")
                                .foregroundStyle(mp.ratingDelta == nil ? Palette.muted : mp.ratingDelta! >= 0 ? Palette.win : Palette.danger)
                                .textStyle(TextSpec(face: .mono(weight: 600), size: 13, relativeTo: .footnote))
                        }
                    }
                }
                .padding(.top, 12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line, lineWidth: 1))
    }
}

private let reviewSub = "An exec is reviewing this and will settle it. Ratings stay unchanged until they do."

private struct DetailActions: View {
    let action: (@Sendable (String, [JSONValue]) async throws -> ActionOutcome)?
    let viewer: Viewer
    let found: ChallengeWithMatch
    let context: AppResult<ChallengeContext>?
    let refreshing: Bool
    let onDone: () -> Void

    @State private var busy = ""
    @State private var error: String?
    @State private var flash: String?
    @State private var dialog: DetailDialog?
    @State private var confirmCancel = false

    init(action: (@Sendable (String, [JSONValue]) async throws -> ActionOutcome)?, viewer: Viewer, found: ChallengeWithMatch, context: AppResult<ChallengeContext>?, refreshing: Bool, onDone: @escaping () -> Void) {
        self.action = action
        self.viewer = viewer
        self.found = found
        self.context = context
        self.refreshing = refreshing
        self.onDone = onDone
        #if DEBUG
        _dialog = State(initialValue: DebugPreview.dialog)
        _confirmCancel = State(initialValue: DebugPreview.confirmCancel)
        #endif
    }

    private var c: ChallengeDetail { found.challenge }
    private var match: ChallengeMatch? { found.match }
    private var reviewing: Bool { match?.resultStatus == "disputed" || c.status == "walkover_pending" }
    private var reviewTitle: String { match?.resultStatus == "disputed" ? "Result disputed" : "Walkover reported" }

    var body: some View {
        let ctx: ChallengeContext? = if case let .ok(value)? = context { value } else { nil }
        VStack(spacing: 12) {
            if let action, let ctx {
                if ctx.standing.ok {
                    controls(action)
                } else {
                    if reviewing { InfoCard(title: reviewTitle, sub: reviewSub) }
                    InfoCard(title: "Actions paused", sub: ctx.standing.detail)
                }
            } else {
                if reviewing { InfoCard(title: reviewTitle, sub: reviewSub) }
                if case let .failed(message)? = context { Notice(text: message) } else { Notice(text: readOnlyNotice) }
            }
        }
        // The busy button clears only once the reload after a write has landed.
        .onChange(of: refreshing) { _, now in if !now { busy = "" } }
        .sheet(item: $dialog) { which in
            if let action { sheet(which, action) }
        }
    }

    @ViewBuilder
    private func controls(_ action: @escaping @Sendable (String, [JSONValue]) async throws -> ActionOutcome) -> some View {
        let isCreator = c.createdBy == viewer.id
        let myStatus = c.participants.first { $0.playerId == viewer.id }?.confirmationStatus
        let isSubmitter = match?.submittedBy == viewer.id
        let open = ["proposed", "partially_confirmed"].contains(c.status)
        let idle = busy.isEmpty

        if let flash { Pill(text: flash, background: Palette.winWash, color: Palette.win) }
        if dialog == nil, let error { AlertBox(text: error) }

        if isCreator && open {
            GhostButton(title: busy == "cancel" ? "Cancelling..." : "Cancel challenge", enabled: idle) { confirmCancel = true }
                .alert("Cancel challenge?", isPresented: $confirmCancel) {
                    Button("Cancel challenge", role: .destructive) {
                        run(action, "cancel", idArgs("cancelChallenge", c.id), "Challenge cancelled")
                    }
                    Button("Keep it", role: .cancel) {}
                } message: {
                    Text("Cancel this challenge? The opponent will be notified.")
                }
        }
        if myStatus == "pending" && open {
            HStack(spacing: 12) {
                ToneButton(title: "Accept", fill: Palette.win, ink: .black, enabled: idle, loading: busy == "accept") {
                    run(action, "accept", idArgs("acceptChallenge", c.id), "Challenge accepted!")
                }
                ToneButton(title: "Reject", fill: Palette.danger, ink: .white, enabled: idle, loading: busy == "reject") {
                    run(action, "reject", idArgs("rejectChallenge", c.id), "Challenge rejected")
                }
            }
        }
        if c.status == "accepted" && match == nil {
            PrimaryButton(title: "Submit result", enabled: idle) { error = nil; dialog = .submit }
            GhostButton(title: "Report issue", enabled: idle) { error = nil; dialog = .walkover }
        }
        if let match, match.resultStatus == "pending_confirmation" {
            if !isSubmitter {
                ToneButton(title: "Confirm result", fill: Palette.win, ink: .black, enabled: idle, loading: busy == "confirm") {
                    run(action, "confirm", idArgs("confirmMatchResult", match.id), "Result confirmed! Elo updated.")
                }
            }
            ToneButton(title: isSubmitter ? "Report an error" : "Dispute", fill: Palette.danger, ink: .white, enabled: idle, loading: false) {
                error = nil
                dialog = .dispute
            }
        }
        if reviewing {
            InfoCard(title: reviewTitle, sub: reviewSub + " There is nothing else to do here.")
        }
    }

    @ViewBuilder
    private func sheet(_ which: DetailDialog, _ action: @escaping @Sendable (String, [JSONValue]) async throws -> ActionOutcome) -> some View {
        let isSubmitter = match?.submittedBy == viewer.id
        switch which {
        case .submit:
            SubmitSheet(
                bestOfThree: c.format == "bo3_21",
                participants: c.participants,
                viewerId: viewer.id,
                submitting: busy == "submit",
                error: error,
                onDismiss: { if busy.isEmpty { dialog = nil } },
            ) { games in
                run(action, "submit", submitResultArgs(c.id, games, bestOfThree: c.format == "bo3_21"), "Result submitted! Waiting for confirmation.") { dialog = nil }
            }
        case .dispute:
            DisputeSheet(isSubmitter: isSubmitter, sending: busy == "dispute", error: error, onDismiss: { if busy.isEmpty { dialog = nil } }) { reason, category in
                if let match {
                    run(action, "dispute", disputeArgs(match.id, reason, category), "Dispute opened") { dialog = nil }
                }
            }
        case .walkover:
            WalkoverSheet(busy: busy, error: error, onDismiss: { dialog = nil }) { type in
                run(action, "walkover", walkoverArgs(c.id, type, viewerId: viewer.id, participants: c.participants), "Walkover reported. Admin will review.") { dialog = nil }
            }
        }
    }

    private func run(_ action: @escaping @Sendable (String, [JSONValue]) async throws -> ActionOutcome, _ key: String, _ built: BuiltArgs, _ success: String, after: @escaping () -> Void = {}) {
        switch built {
        case let .invalid(message):
            error = message
        case let .args(name, args):
            busy = key
            error = nil
            flash = nil
            Task {
                guard let outcome = try? await runAction(action, name, args) else {
                    busy = ""
                    return
                }
                switch outcome {
                case .ok:
                    flash = success
                    after()
                    onDone()
                case let .refused(message), let .failed(message):
                    error = message
                    busy = ""
                }
            }
        }
    }
}

private struct InfoCard: View {
    let title: String
    let sub: String

    var body: some View {
        Card {
            Text(title).foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
            Text(sub).foregroundStyle(Palette.muted).textStyle(TypeStyle.cardSub).padding(.top, 4)
        }
    }
}

/// The web's success and danger buttons: a solid fill in the given colour.
private struct ToneButton: View {
    let title: String
    let fill: Color
    let ink: Color
    let enabled: Bool
    let loading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text((loading ? "Working..." : title).uppercased())
                .foregroundStyle(enabled ? ink : ink.opacity(0.55))
                .textStyle(TypeStyle.button)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(enabled ? fill : fill.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

private func teamName(_ participants: [ChallengeParticipant], _ side: String) -> String {
    let names = participants.filter { $0.teamSide == side }.compactMap { $0.person?.fullName }.filter { !$0.isEmpty }
    return names.isEmpty ? "Unknown" : names.joined(separator: " + ")
}

/// A sheet's frame: the title, the body, then Close and the confirm button.
private struct DialogFrame<Content: View, Buttons: View>: View {
    let title: String
    @ViewBuilder var content: Content
    @ViewBuilder var buttons: Buttons

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(title).foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle).padding(.bottom, 4)
                content
                HStack {
                    Spacer()
                    buttons
                }
            }
            .padding(20)
        }
        .background(Palette.surface.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

private struct SubmitSheet: View {
    let bestOfThree: Bool
    let participants: [ChallengeParticipant]
    let viewerId: String
    let submitting: Bool
    let error: String?
    let onDismiss: () -> Void
    let onSubmit: ([GameScore]) -> Void
    @State private var scores: [String]

    init(bestOfThree: Bool, participants: [ChallengeParticipant], viewerId: String, submitting: Bool, error: String?, onDismiss: @escaping () -> Void, onSubmit: @escaping ([GameScore]) -> Void) {
        self.bestOfThree = bestOfThree
        self.participants = participants
        self.viewerId = viewerId
        self.submitting = submitting
        self.error = error
        self.onDismiss = onDismiss
        self.onSubmit = onSubmit
        _scores = State(initialValue: Array(repeating: "", count: bestOfThree ? 6 : 2))
    }

    var body: some View {
        let games = stride(from: 0, to: scores.count, by: 2).map { GameScore(sideA: scores[$0], sideB: scores[$0 + 1]) }
        let tally = tallyGames(games)
        let nameA = teamName(participants, "a")
        let nameB = teamName(participants, "b")
        let mySide = participants.first { $0.playerId == viewerId }?.teamSide
        let labelA = mySide == "a" ? "Your team (\(nameA))" : nameA
        let labelB = mySide == "b" ? "Your team (\(nameB))" : nameB
        let compactA = nameA.utf16.count > 20 ? "Team A" : nameA
        let compactB = nameB.utf16.count > 20 ? "Team B" : nameB
        let winner = switch tally.winner {
        case "a": "Winner: \(labelA)"
        case "b": "Winner: \(labelB)"
        default: "Winner: enter the game scores"
        }

        DialogFrame(title: "Submit match result") {
            VStack(alignment: .leading, spacing: 2) {
                Text(winner).foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                Text("\(tally.aGamesWon)-\(tally.bGamesWon) in games" + (tally.winner == nil ? ". Tied or incomplete, so the result cannot be submitted yet." : ""))
                    .foregroundStyle(Palette.muted)
                    .textStyle(TypeStyle.cardSub)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line, lineWidth: 1))
            ForEach(0..<(scores.count / 2), id: \.self) { g in
                HStack(spacing: 10) {
                    ScoreField(label: "Game \(g + 1): \(compactA)", value: $scores[g * 2])
                    ScoreField(label: "Game \(g + 1): \(compactB)", value: $scores[g * 2 + 1])
                }
            }
            if let error { AlertBox(text: error) }
        } buttons: {
            HStack(spacing: 0) {
                SheetButton(title: "Close", color: Palette.ink2, enabled: !submitting, action: onDismiss)
                SheetButton(title: submitting ? "Submitting..." : "Submit", color: Palette.accent, enabled: !submitting) { onSubmit(games) }
            }
        }
        .interactiveDismissDisabled(submitting)
    }
}

private struct ScoreField: View {
    let label: String
    @Binding var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).foregroundStyle(Palette.muted).textStyle(TypeStyle.body(12)).lineLimit(1)
            // Digits only; empty is allowed so a field can be cleared and typed over.
            TextField("", text: Binding(get: { value }, set: { value = String($0.filter { ("0"..."9").contains($0) }.prefix(2)) }))
                .keyboardType(.numberPad)
                .foregroundStyle(Palette.text)
                .textStyle(TextSpec(face: .mono(weight: 400), size: 16, relativeTo: .body))
                .fieldBox(focused: false)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct DisputeSheet: View {
    let isSubmitter: Bool
    let sending: Bool
    let error: String?
    let onDismiss: () -> Void
    let onSend: (String, String) -> Void
    @State private var category = disputeCategories[0].value
    @State private var reason = ""

    var body: some View {
        DialogFrame(title: isSubmitter ? "Report an error in your result" : "Dispute result") {
            SectionLabel(text: "Reason")
            VStack(spacing: 0) {
                ForEach(disputeCategories, id: \.value) { value, label in
                    Button { category = value } label: {
                        HStack(spacing: 12) {
                            Circle()
                                .strokeBorder(category == value ? Palette.accent : Palette.muted, lineWidth: 2)
                                .overlay(Circle().fill(category == value ? Palette.accent : .clear).padding(5))
                                .frame(width: 20, height: 20)
                            Text(label).foregroundStyle(Palette.text).textStyle(TypeStyle.body(14))
                            Spacer()
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(category == value ? [.isSelected] : [])
                }
            }
            SectionLabel(text: "Description").padding(.top, 4)
            TextField("", text: Binding(get: { reason }, set: { reason = capUtf16($0, 1000) }), prompt: Text("Describe the issue...").foregroundStyle(Palette.placeholder), axis: .vertical)
                .lineLimit(3...8)
                .foregroundStyle(Palette.text)
                .textStyle(TypeStyle.body(14))
                .padding(.vertical, 12)
                .fieldBox(focused: false)
            Text("At least \(disputeMin) characters.").foregroundStyle(Palette.muted).textStyle(TypeStyle.body(12))
            if let error { AlertBox(text: error) }
        } buttons: {
            HStack(spacing: 0) {
                SheetButton(title: "Close", color: Palette.ink2, enabled: !sending, action: onDismiss)
                SheetButton(title: sending ? "Opening..." : "Open dispute", color: Palette.danger, enabled: !sending) { onSend(reason, category) }
            }
        }
        .interactiveDismissDisabled(sending)
    }
}

private struct WalkoverSheet: View {
    let busy: String
    let error: String?
    let onDismiss: () -> Void
    let onReport: (String) -> Void

    var body: some View {
        let idle = busy.isEmpty
        DialogFrame(title: "Report issue") {
            Text("What happened?").foregroundStyle(Palette.muted).textStyle(TypeStyle.body(14))
            if let error { AlertBox(text: error) }
            ToneButton(title: "Opponent no-show", fill: Palette.danger, ink: .white, enabled: idle, loading: busy == "walkover") { onReport("no_show") }
            GhostButton(title: "I need to withdraw", enabled: idle) { onReport("withdrawal") }
        } buttons: {
            SheetButton(title: "Close", color: Palette.ink2, enabled: idle, action: onDismiss)
        }
        .interactiveDismissDisabled(!idle)
    }
}
