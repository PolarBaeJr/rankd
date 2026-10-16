import SwiftUI

// Port of FeedScreen.kt: the web's /feed on one scrolling page, read only.
// Deferred from the web: the month calendar (desktop only there), realtime
// (pull to refresh instead), subscribe-to-calendar, RSVP buttons,
// add-to-calendar, check-in without a scan, and the passkey nudge. The one
// action is the door-code scan, which runs the existing check-in path.

struct FeedScreen: View {
    let viewer: Viewer
    let refreshKey: Int
    /// A session id from a /feed?s= or /sessions?s= link: the page scrolls to its card once, then clears it.
    @Binding var focusSession: String?
    let onScan: (() -> Void)?
    /// The website's address is known, so web-only links open in the browser; without it those rows are not tappable.
    let canBrowse: Bool
    let onLink: (FeedLink) -> Void
    @State private var loader: Loader<Feed>
    @State private var showMore = false
    @State private var target: String?

    init(
        viewer: Viewer,
        load: @escaping @Sendable (Viewer) async throws -> Feed,
        refreshKey: Int,
        focusSession: Binding<String?>,
        onScan: (() -> Void)?,
        canBrowse: Bool,
        onLink: @escaping (FeedLink) -> Void,
    ) {
        self.viewer = viewer
        self.refreshKey = refreshKey
        _focusSession = focusSession
        self.onScan = onScan
        self.canBrowse = canBrowse
        self.onLink = onLink
        _loader = State(initialValue: Loader { try await load(viewer) })
    }

    var body: some View {
        Group {
            switch loader.state {
            case .loading:
                VStack(spacing: 0) {
                    PageHeader(title: "Feed")
                    LoadingView()
                }
            case let .failed(message):
                VStack(spacing: 0) {
                    PageHeader(title: "Feed")
                    ErrorState(message: message) { loader.load() }
                }
            case let .loaded(feed):
                page(feed)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .task(id: "\(viewer.id)|\(viewer.status ?? "")|\(refreshKey)") { loader.load() }
        .onDisappear { loader.cancel() }
    }

    private func tap(_ link: FeedLink) -> (() -> Void)? {
        if case .web = link, !canBrowse { return nil }
        return { onLink(link) }
    }

    private func jump(to dateISO: String) {
        if case let .loaded(feed) = loader.state, feed.agendaLater.contains(where: { $0.dateISO == dateISO }) { showMore = true }
        target = "day:\(dateISO)"
    }

    private func applyFocus(_ feed: Feed) {
        guard let id = focusSession else { return }
        let key = "session:\(id)"
        func holds(_ days: [AgendaDay]) -> Bool { days.contains { $0.rows.contains { $0.key == key } } }
        if holds(feed.agendaLater) { showMore = true }
        if holds(feed.agendaSoon) || holds(feed.agendaLater) { target = "agenda:\(key)" }
        focusSession = nil
    }

    private func page(_ feed: Feed) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 12) {
                    FeedHeader(feed: feed, viewer: viewer)
                    if let s = feed.standing {
                        SpineCard(spine: Palette.accent) {
                            Text(s.title).foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                            BodyText(text: s.body, muted: true)
                        }
                    }
                    if let amount = feed.paymentAmount {
                        SpineCard(spine: Palette.gold) {
                            BodyText(text: "You have \(amount) unpaid. Pay and upload your receipt.")
                            PrimaryButton(title: "Pay now") { onLink(.membership) }
                        }
                    }
                    if let onScan, feed.sessionsOn {
                        GhostButton(title: "Scan the door code", icon: "scan", action: onScan)
                    }
                    ForEach(feed.liveTournaments, id: \.id) { t in
                        LiveTournament(card: t, tap: tap)
                    }
                    if feed.scheduleOn { schedule(feed) }
                    Activity(feed: feed, canBrowse: canBrowse, tap: tap, onLink: onLink)
                    You(you: feed.you, onLink: onLink)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 20)
            }
            .refreshable { await loader.refresh() }
            .onAppear { applyFocus(feed) }
            .onChange(of: focusSession) { applyFocus(feed) }
            .onChange(of: target) {
                guard let t = target else { return }
                target = nil
                // After the fold opens, so the row it scrolls to exists.
                Task { @MainActor in
                    await Task.yield()
                    withAnimation { proxy.scrollTo(t, anchor: .top) }
                }
            }
        }
    }

    @ViewBuilder
    private func schedule(_ feed: Feed) -> some View {
        WeekStrip(week: feed.week, agendaDates: feed.agendaDates, onDay: jump(to:))
        SectionHead(title: "Up next", sub: feed.upNextSub)
        if feed.scheduleError {
            SpineCard(spine: nil) {
                Text("We could not load the schedule").foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                BodyText(text: "Pull down to try again.", muted: true)
            }
        }
        if let e = feed.empty {
            SpineCard(spine: nil) {
                Text(e.title).foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                BodyText(text: e.hint, muted: true)
            }
        }
        ForEach(showMore ? feed.agendaSoon + feed.agendaLater : feed.agendaSoon, id: \.dateISO) { day in
            DayRail(day: day).id("day:\(day.dateISO)")
            ForEach(day.rows, id: \.key) { row in
                Group {
                    switch row {
                    case let .session(s): SessionCard(row: s, onScan: onScan)
                    case let .clubEvent(e): ClubEventRow(row: e, onTap: tap(e.link))
                    case let .tournament(t): TournamentRow(row: t, onTap: tap(t.link))
                    }
                }
                .id("agenda:\(row.key)")
            }
        }
        if !showMore, !feed.agendaLater.isEmpty {
            let n = feed.agendaLater.count
            TextLink(text: "Show \(n) more \(n == 1 ? "date" : "dates")") { showMore = true }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        if feed.clubEventsError || feed.tournamentsError {
            VStack(alignment: .leading, spacing: 4) {
                if feed.clubEventsError { BodyText(text: "Club events could not be loaded right now.", muted: true) }
                if feed.tournamentsError { BodyText(text: "Tournaments could not be loaded right now.", muted: true) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct FeedHeader: View {
    let feed: Feed
    let viewer: Viewer

    var body: some View {
        HStack(alignment: .bottom) {
            PageHeader(title: "Feed", eyebrow: feed.eyebrow, padding: EdgeInsets(top: 20, leading: 0, bottom: 8, trailing: 0))
            Avatar(name: viewer.fullName ?? "?", seed: viewer.id, size: .sm).padding(.bottom, 8)
        }
    }
}

/// A card with an optional 3pt coloured spine down its left edge, as the web's session and banner cards.
private struct SpineCard<Content: View>: View {
    let spine: Color?
    var onTap: (() -> Void)? = nil
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12)
        let card = VStack(alignment: .leading, spacing: 6) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface)
            .overlay(alignment: .leading) {
                if let spine { Rectangle().fill(spine).frame(width: 3) }
            }
            .clipShape(shape)
            .overlay(shape.strokeBorder(Palette.line, lineWidth: 1))
        if let onTap {
            Button(action: onTap) { card.contentShape(shape) }.buttonStyle(.plain)
        } else {
            card
        }
    }
}

private struct SectionHead: View {
    let title: String
    let sub: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).foregroundStyle(Palette.text).textStyle(TextSpec(face: .condensed, size: 22, relativeTo: .title3))
            Text(sub).foregroundStyle(Palette.muted).textStyle(TypeStyle.cardSub)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }
}

private struct LiveTournament: View {
    let card: LiveTournamentCard
    let tap: (FeedLink) -> (() -> Void)?

    var body: some View {
        SpineCard(spine: Palette.accent) {
            Text(card.eyebrow).foregroundStyle(Palette.accent).textStyle(TypeStyle.label)
            Text(card.name).foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
            if !card.meta.isEmpty { Text(card.meta).foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub) }
            ForEach(Array(card.entries.enumerated()), id: \.offset) { _, e in
                let row = HStack {
                    Text(e.eventLabel).foregroundStyle(Palette.text).textStyle(TypeStyle.rowTitle)
                    Spacer()
                    if e.checkedIn {
                        Pill(text: "Checked in", background: Palette.winWash, color: Palette.win)
                    } else {
                        Pill(text: "Not checked in", background: Palette.surface3, color: Palette.muted)
                    }
                }
                .frame(minHeight: 40)
                .contentShape(Rectangle())
                if let action = tap(e.link) {
                    Button(action: action) { row }.buttonStyle(.plain)
                } else {
                    row
                }
            }
            if let text = card.notEntered {
                BodyText(text: text, muted: true)
                if let action = tap(card.follow) { GhostButton(title: "Follow the draw", action: action) }
            }
        }
    }
}

private struct WeekStrip: View {
    let week: [WeekStripDay]
    let agendaDates: Set<String>
    let onDay: (String) -> Void

    var body: some View {
        HStack(spacing: 4) {
            ForEach(week, id: \.dateISO) { d in
                let shape = RoundedRectangle(cornerRadius: 8)
                let cell = VStack(spacing: 4) {
                    Text(d.weekday.uppercased()).foregroundStyle(d.isToday ? Palette.accent : Palette.muted).textStyle(TypeStyle.statLabel)
                    Text("\(d.day)").foregroundStyle(Palette.text).textStyle(TypeStyle.sessTime)
                    HStack(spacing: 3) {
                        ForEach(Array(d.marks.enumerated()), id: \.offset) { _, m in
                            Circle().fill(Palette.tone(m)).frame(width: 6, height: 6)
                        }
                        if d.more > 0 { Text("+\(d.more)").foregroundStyle(Palette.muted).font(.system(size: 9)) }
                    }
                    .frame(minHeight: 12)
                }
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(d.isToday ? Palette.highlight : Palette.surface, in: shape)
                .overlay(shape.strokeBorder(d.isToday ? Palette.redBorder : Palette.line, lineWidth: 1))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(d.summary)
                if agendaDates.contains(d.dateISO) {
                    Button { onDay(d.dateISO) } label: { cell.contentShape(shape) }.buttonStyle(.plain)
                } else {
                    cell
                }
            }
        }
        .padding(.top, 4)
    }
}

private struct DayRail: View {
    let day: AgendaDay

    var body: some View {
        HStack(spacing: 0) {
            Text(day.label.uppercased()).foregroundStyle(day.isToday ? Palette.accent : Palette.text).textStyle(TypeStyle.sessDate)
            Text("  \(day.dateLabel.uppercased())").foregroundStyle(Palette.muted).textStyle(TypeStyle.sessDate)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }
}

private struct SessionCard: View {
    let row: FeedAgendaRow.Session
    let onScan: (() -> Void)?

    var body: some View {
        SpineCard(spine: row.isNext ? Palette.accent : nil) {
            if row.isNext { Text("NEXT UP").foregroundStyle(Palette.accent).textStyle(TypeStyle.label) }
            HStack(spacing: 8) {
                Text(row.name).foregroundStyle(Palette.text).textStyle(TextSpec(face: .condensed, size: 22, relativeTo: .title3))
                if let tag = row.trackTag { Tag(text: tag, background: Palette.surface3, color: Palette.ink2) }
            }
            Text(row.timeLabel).foregroundStyle(Palette.text).textStyle(TypeStyle.sessTime)
            Text(meta).foregroundStyle(Palette.muted).textStyle(TypeStyle.sessMeta)
            if let notes = row.notes { BodyText(text: notes, muted: true) }
            if let chip = row.stateChip {
                let present = chip == "Checked In" || chip == "Attended"
                Pill(text: chip, background: present ? Palette.winWash : Palette.surface3, color: present ? Palette.win : Palette.muted)
            }
            if let label = row.windowLabel { Text(label).foregroundStyle(Palette.muted).textStyle(TypeStyle.sessMeta) }
            if row.canScan, let onScan {
                PrimaryButton(title: "Scan to check in", icon: "scan", action: onScan)
            }
        }
    }

    private var meta: String {
        [row.location, "\(row.goingCount) going", row.checkedInCount > 0 ? "\(row.checkedInCount) checked in" : nil]
            .compactMap { $0 }
            .joined(separator: " \u{00B7} ")
    }
}

private struct ClubEventRow: View {
    let row: FeedAgendaRow.ClubEvent
    let onTap: (() -> Void)?

    var body: some View {
        SpineCard(spine: nil, onTap: onTap) {
            HStack(spacing: 8) {
                Tag(text: row.kindLabel.uppercased(), background: Palette.surface3, color: Palette.gold)
                if row.cancelled {
                    Tag(text: "CANCELLED", background: Palette.surface3, color: Palette.muted)
                } else if row.going {
                    Pill(text: "Going", background: Palette.winWash, color: Palette.win)
                }
            }
            Text(row.title)
                .strikethrough(row.cancelled)
                .foregroundStyle(row.cancelled ? Palette.muted : Palette.text)
                .textStyle(TypeStyle.rowTitle)
            if !row.meta.isEmpty { Text(row.meta).foregroundStyle(Palette.muted).textStyle(TypeStyle.sessMeta) }
        }
    }
}

private struct TournamentRow: View {
    let row: FeedAgendaRow.Tournament
    let onTap: (() -> Void)?

    var body: some View {
        SpineCard(spine: nil, onTap: onTap) {
            Tag(text: "TOURNAMENT", background: Palette.surface3, color: Palette.ink2)
            Text(row.name).foregroundStyle(Palette.text).textStyle(TypeStyle.rowTitle)
            Text(row.whenLabel).foregroundStyle(Palette.muted).textStyle(TypeStyle.sessMeta)
        }
    }
}

private struct Activity: View {
    let feed: Feed
    let canBrowse: Bool
    let tap: (FeedLink) -> (() -> Void)?
    let onLink: (FeedLink) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHead(title: "Club activity", sub: "Results, challenges and club notices.")
            if let n = feed.notice {
                SpineCard(spine: Palette.accent, onTap: tap(.web("/announcements"))) {
                    Text("CLUB NOTICE").foregroundStyle(Palette.accent).textStyle(TypeStyle.label)
                    Text(n.title).foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                    BodyText(text: n.body)
                    Text(n.meta).foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub)
                }
            }
            Card(padding: 16) {
                if feed.river.isEmpty {
                    Text("Nothing has happened yet").foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                    BodyText(
                        text: "Results and challenges land here as the club plays. Issue a challenge to put the first one on the board.",
                        muted: true,
                    )
                    if feed.showChallengeCta {
                        PrimaryButton(title: "Issue a challenge") { onLink(.newChallenge) }.padding(.top, 12)
                    }
                } else {
                    ForEach(Array(feed.river.enumerated()), id: \.element.key) { i, section in
                        Text(section.label.uppercased())
                            .foregroundStyle(Palette.muted)
                            .textStyle(TypeStyle.label)
                            .padding(.top, i == 0 ? 0 : 12)
                            .padding(.bottom, 4)
                        ForEach(section.items, id: \.key) { row in RiverItem(row: row, onTap: tap(row.link)) }
                    }
                    Rectangle().fill(Palette.line).frame(height: 1).padding(.top, 8)
                    Text(feed.riverEnd.uppercased()).foregroundStyle(Palette.dim).textStyle(TypeStyle.label).padding(.top, 8)
                }
            }
            if canBrowse {
                HStack(spacing: 16) {
                    TextLink(text: "All notifications") { onLink(.web("/notifications")) }
                    if feed.announcementsOn { TextLink(text: "Announcements") { onLink(.web("/announcements")) } }
                }
            }
        }
    }
}

private struct RiverItem: View {
    let row: RiverRow
    let onTap: (() -> Void)?

    var body: some View {
        let content = HStack(spacing: 12) {
            Avatar(name: row.face.name, seed: row.face.id, size: .sm)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.sentence).foregroundStyle(Palette.text).textStyle(TypeStyle.rowTitle)
                Text(row.meta).foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub)
            }
            Spacer(minLength: 0)
            if row.isChallenge {
                Tag(text: "REPLY", background: Palette.highlight, color: Palette.accent)
            } else if let delta = row.delta {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(delta).foregroundStyle(row.deltaUp ? Palette.win : Palette.accent).textStyle(TypeStyle.lrValue)
                    if let rating = row.rating { Text(rating).foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub) }
                }
            }
        }
        .frame(minHeight: 48)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        if let onTap {
            Button(action: onTap) { content }.buttonStyle(.plain)
        } else {
            content
        }
    }
}

private struct You: View {
    let you: YouCard
    let onLink: (FeedLink) -> Void

    var body: some View {
        Card(padding: 16) {
            SectionLabel(text: "You")
            HStack(alignment: .top, spacing: 20) {
                if let streak = you.streak { Figure(label: "Streak", value: "\(streak)", sub: nil) }
                ForEach(you.figures, id: \.label) { f in Figure(label: f.label, value: f.value, sub: f.sub) }
            }
            if let note = you.note { BodyText(text: note, muted: true).padding(.top, 8) }
            if you.showMyStats {
                GhostButton(title: "My stats") { onLink(.myStats) }.padding(.top, 12)
            }
        }
    }
}

private struct Figure: View {
    let label: String
    let value: String
    let sub: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label.uppercased()).foregroundStyle(Palette.muted).textStyle(TypeStyle.statLabel)
            Text(value).foregroundStyle(Palette.text).textStyle(TextSpec(face: .condensed, size: 24, lineHeight: 24, trackingEm: -0.02, relativeTo: .title))
            if let sub { Text(sub).foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub).padding(.top, 2) }
        }
    }
}
