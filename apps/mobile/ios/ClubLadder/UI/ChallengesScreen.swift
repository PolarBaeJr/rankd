import SwiftUI

// Port of ChallengesScreen.kt (apps/player/src/app/challenges/page.tsx). Reads
// are the member's own PostgREST reads; the standing, the switch, the rules and
// the quota come from the website's context route. When that route cannot be
// reached (an older website, no network) the list still reads and every write
// control is withheld, with the reason on screen.

let readOnlyNotice = "This build has no club website set, so challenges are read-only here."

/// The web's .tag colours.
func tagColors(_ tone: TagTone) -> (Color, Color) {
    switch tone {
    case .gold: return (Color(hex: 0x1FEAB308), Palette.gold)
    case .win: return (Palette.winWash, Palette.win)
    case .red: return (Palette.highlight, Palette.danger)
    case .plain: return (Palette.surface2, Palette.ink2)
    }
}

struct ToneTag: View {
    let text: String
    let tone: TagTone

    var body: some View {
        let (bg, fg) = tagColors(tone)
        Tag(text: text, background: bg, color: fg)
    }
}

/// Children laid out left to right, wrapping onto a new line when the row is full.
struct FlowRow: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private func arrange(_ maxWidth: CGFloat, _ subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (items: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.items.isEmpty ? size.width : current.width + spacing + size.width
            if !current.items.isEmpty && needed > maxWidth {
                rows.append(current)
                current = ([index], size.width, size.height)
            } else {
                current = (current.items + [index], needed, max(current.height, size.height))
            }
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}

struct ChallengesData: Sendable {
    let items: [ChallengeListItem]
    let context: AppResult<ChallengeContext>?
}

private let challengesSub =
    "Issue, accept, and track challenges. Whatever is waiting on you sits at the top. Answer it so the queue clears."

struct ChallengesScreen: View {
    let viewer: Viewer
    let onOpen: (String) -> Void
    let onNew: () -> Void
    @State private var loader: Loader<ChallengesData>

    init(data: ScreenData, viewer: Viewer, onOpen: @escaping (String) -> Void, onNew: @escaping () -> Void) {
        self.viewer = viewer
        self.onOpen = onOpen
        self.onNew = onNew
        let id = viewer.id
        let list = data.challenges
        let context = data.context
        _loader = State(initialValue: Loader {
            async let items = list(id)
            async let ctx = loadContext(context)
            return ChallengesData(items: try await items, context: try await ctx)
        })
    }

    private let header = EdgeInsets(top: 20, leading: 0, bottom: 6, trailing: 0)

    var body: some View {
        Group {
            switch loader.state {
            case .loading:
                VStack(spacing: 0) {
                    PageHeader(title: "Challenges", sub: challengesSub)
                    LoadingView()
                }
            case let .failed(message):
                VStack(spacing: 0) {
                    PageHeader(title: "Challenges", sub: challengesSub)
                    ErrorState(message: message) { loader.load() }
                }
            case let .loaded(data):
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        PageHeader(title: "Challenges", sub: challengesSub, padding: header)
                        content(data)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 20)
                }
                .refreshable { await loader.refresh() }
            }
        }
        .task(id: viewer.id) { loader.load() }
        .onDisappear { loader.cancel() }
    }

    @ViewBuilder
    private func content(_ data: ChallengesData) -> some View {
        let ctx: ChallengeContext? = if case let .ok(value)? = data.context { value } else { nil }
        let contextProblem: String? = switch data.context {
        case nil: readOnlyNotice
        case let .failed(message)?: message
        case .ok?: nil
        }
        // The web sends a member away from /challenges while the switch is
        // off; here the screen says so and shows nothing.
        if let ctx, !ctx.featureOn {
            Notice(text: ctx.featureMessage ?? "The club has switched challenges off for now.")
        } else {
            let parts = partitionChallenges(data.items, viewerId: viewer.id)
            let now = nowMillis()
            IssueControl(ctx: ctx, contextProblem: contextProblem, onNew: onNew)
            if let ctx, ctx.standing.ok { StatStrip(ctx: ctx, awaiting: parts.incoming.count) }
            if data.items.isEmpty {
                EmptyChallenges(ctx: ctx, onNew: onNew)
            } else {
                let sections: [(String, [ChallengeListItem], Bool)] = [
                    ("Awaiting your answer", parts.incoming, true),
                    ("Active", parts.active, false),
                    ("Your challenges", parts.outgoing, false),
                    ("Archived", sortArchived(parts.archived), false),
                ]
                ForEach(sections.filter { !$0.1.isEmpty }, id: \.0) { title, rows, awaiting in
                    Card(padding: 16) {
                        HStack {
                            Text(title).foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                            Spacer()
                            ToneTag(text: String(rows.count), tone: .plain)
                        }
                        .padding(.bottom, 12)
                        VStack(spacing: 10) {
                            ForEach(rows, id: \.rowId) { row in
                                ChallengeCard(item: row, viewerId: viewer.id, awaitingYou: awaiting, now: now) { onOpen(row.challenge.id) }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The page header's action: the button, the quota sentence, or why challenges are paused.
private struct IssueControl: View {
    let ctx: ChallengeContext?
    let contextProblem: String?
    let onNew: () -> Void

    var body: some View {
        if let ctx {
            if !ctx.standing.ok {
                Notice(text: ctx.standing.detail)
            } else if ctx.canIssue {
                PrimaryButton(title: "New challenge", action: onNew)
            } else {
                Text(quotaFullNote(ctx))
                    .foregroundStyle(Palette.muted)
                    .textStyle(TextSpec(face: .mono(weight: 400), size: 12, relativeTo: .caption))
            }
        } else {
            Notice(text: contextProblem ?? readOnlyNotice)
        }
    }
}

func quotaFullNote(_ ctx: ChallengeContext) -> String {
    "You have \(ctx.quota.used) of \(ctx.quota.max) challenges open. Play or cancel one to issue another."
}

private struct StatStrip: View {
    let ctx: ChallengeContext
    let awaiting: Int

    var body: some View {
        Card(padding: 0) {
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("OPEN CHALLENGES").foregroundStyle(Palette.muted).textStyle(TypeStyle.statLabel).lineLimit(1)
                    (Text(String(ctx.quota.used)).foregroundColor(Palette.text)
                        + Text(" / \(ctx.quota.max)").foregroundColor(Palette.muted).font(.custom(FontName.jetBrainsMono, size: 15, relativeTo: .callout)))
                        .textStyle(TextSpec(face: .mono(weight: 700), size: 28, lineHeight: 28, trackingEm: -0.02, relativeTo: .title))
                        .padding(.top, 6)
                    CapacityBar(ratio: ctx.quota.ratio, full: ctx.quota.full)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                StatCell(label: "AWAITING YOU", value: String(awaiting))
                StatCell(label: "REPLY WINDOW", value: "\(ctx.rules.expiryHours)h")
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct StatCell: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).foregroundStyle(Palette.muted).textStyle(TypeStyle.statLabel).lineLimit(1).truncationMode(.tail)
            Text(value)
                .foregroundStyle(Palette.text)
                .textStyle(TextSpec(face: .mono(weight: 700), size: 28, lineHeight: 28, trackingEm: -0.02, relativeTo: .title))
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(14)
        .overlay(alignment: .leading) { Rectangle().fill(Palette.line).frame(width: 1) }
    }
}

private struct CapacityBar: View {
    let ratio: Double
    let full: Bool

    var body: some View {
        let fill = full ? Palette.danger : ratio >= 0.66 ? Palette.warning : Palette.win
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Palette.surface3
                fill.frame(width: geo.size.width * min(1, max(0, ratio)))
            }
        }
        .frame(height: 4)
        .clipShape(RoundedRectangle(cornerRadius: 2))
        .padding(.top, 8)
    }
}

private struct EmptyChallenges: View {
    let ctx: ChallengeContext?
    let onNew: () -> Void

    var body: some View {
        Card {
            Text("No challenges yet").foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
            Text(hint)
                .foregroundStyle(Palette.muted)
                .textStyle(TypeStyle.cardSub)
                .padding(.top, 6)
                .padding(.bottom, 14)
            if let ctx, ctx.canIssue { PrimaryButton(title: "Issue your first challenge", action: onNew) }
        }
    }

    private var hint: String {
        guard let ctx else { return "Pick someone from the ladder and send one." }
        return "Pick someone from the ladder and send one. You can have \(ctx.quota.max) open at a time, and an " +
            "unanswered challenge stands for \(ctx.rules.expiryHours) hours." + reachSentence(ctx)
    }
}

/// The page's reach clause, as its own sentence. 9999 is the "no limit" sentinel and is never quoted.
func reachSentence(_ ctx: ChallengeContext) -> String {
    let noLimit = 9999
    var reach: [String] = []
    if ctx.rules.ladderRange < noLimit { reach.append("\(ctx.rules.ladderRange) ladder positions") }
    if ctx.rules.eloRange < noLimit { reach.append("\(ctx.rules.eloRange) Elo") }
    return reach.isEmpty ? "" : " Opponents must be within \(reach.joined(separator: " and "))."
}

// Names only: with handles the card title wrapped to three lines on a phone.
private func named(_ person: Person?, _ fallback: String = "Unknown") -> String {
    let name = person?.fullName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return name.isEmpty ? fallback : name
}

private struct ChallengeCard: View {
    let item: ChallengeListItem
    let viewerId: String
    let awaitingYou: Bool
    let now: Int64
    let onClick: () -> Void

    var body: some View {
        let c = item.challenge
        let creator = c.creatorPerson
        let isMine = c.createdBy == viewerId
        let expiry = expiryState(c.expiresAt, c.status, now: now)
        let roster = c.participants.compactMap { cp in cp.person.map { (cp, $0) } }
        let youSide = roster.first { $0.1.id == viewerId }?.0.teamSide
        let opponents = roster.filter { $0.0.teamSide != youSide }
        let teammates = roster.filter { $0.0.teamSide == youSide && $0.1.id != viewerId }
        let vs = opponents.isEmpty ? "Awaiting roster" : "vs " + opponents.map { named($0.1) }.joined(separator: " & ")
        let with = teammates.isEmpty ? "" : " \u{00B7} with " + teammates.map { named($0.1) }.joined(separator: ", ")

        Button(action: onClick) {
            VStack(alignment: .leading, spacing: 0) {
                FlowRow(spacing: 8, lineSpacing: 6) {
                    ToneTag(text: c.type.uppercased(), tone: .red)
                    ToneTag(text: formatLabel(c.format), tone: .plain)
                    if c.ratedFlag { ToneTag(text: "RATED", tone: .gold) }
                    if let label = expiry.label {
                        ToneTag(text: label, tone: expiry.kind == .open ? .plain : expiry.kind == .urgent ? .gold : .red)
                    }
                    Text(formatRelativeTime(c.createdAt, now: now)).foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub)
                }
                .padding(.bottom, 12)
                HStack(spacing: 0) {
                    Avatar(name: creator?.fullName ?? "?", seed: creator?.id ?? c.id, size: .md)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(isMine ? "You challenged" : "\(named(creator)) challenged you")
                            .foregroundStyle(Palette.text)
                            .textStyle(TypeStyle.body(14, weight: 600))
                        Text(vs + with).foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub)
                        if let date = c.scheduledDate {
                            let time = c.scheduledTime.map { " \u{00B7} \($0.prefix(5))" } ?? ""
                            Text(date + time).foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 10)
                    .padding(.trailing, 8)
                    ToneTag(text: challengeStatusLabel[c.status] ?? c.status, tone: challengeStatusTone[c.status] ?? .plain)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface)
            .overlay(alignment: .leading) {
                if awaitingYou { Palette.accent.frame(width: 3) }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}
