import SwiftUI

// Port of LeaderboardScreen.kt.

// The chips spell the ladders out, as the web's do; `label` stays the short
// form the data layer and its tests use.
private extension LeaderboardTab {
    var title: String {
        switch self {
        case .openSingles: return "Open Singles"
        case .openDoubles: return "Open Doubles"
        case .compSingles: return "Comp Singles"
        case .compDoubles: return "Comp Doubles"
        }
    }
}

private func medal(_ rank: Int) -> Color? {
    switch rank {
    case 1: return Palette.gold
    case 2: return Palette.silver
    case 3: return Palette.bronze
    default: return nil
    }
}

// A debug preview can open the ladder scrolled to its end (see DebugPreview).
#if DEBUG
private let initialAnchor: UnitPoint? = DebugPreview.scrollToBottom ? .bottom : nil
#else
private let initialAnchor: UnitPoint? = nil
#endif

private struct RanksHeader: View {
    var body: some View {
        PageHeader(title: "Ranks", eyebrow: "Ladder", sub: "Where you sit against everyone.")
    }
}

struct LeaderboardScreen: View {
    let viewer: Viewer
    let onChallenge: ((String) -> Void)?
    // get_leaderboard() is the database's own filtered ladder. Nothing else
    // here reads another member's rating.
    @State private var loader: Loader<[LadderRow]>
    @State private var tab: LeaderboardTab = .openSingles

    init(viewer: Viewer, load: @escaping @Sendable () async throws -> [LadderRow], onChallenge: ((String) -> Void)?) {
        self.viewer = viewer
        self.onChallenge = onChallenge
        _loader = State(initialValue: Loader(load))
    }

    var body: some View {
        Group {
            switch loader.state {
            case .loading:
                VStack(spacing: 0) {
                    RanksHeader()
                    LoadingView()
                }
            case let .failed(message):
                VStack(spacing: 0) {
                    RanksHeader()
                    ErrorState(message: message) { loader.load() }
                }
            case let .loaded(rows):
                ladder(rankLadder(rows, tab))
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .task(id: viewer.id) { loader.load() }
        .onDisappear { loader.cancel() }
    }

    private func ladder(_ ranked: [RankedRow]) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                RanksHeader()
                Chips(tab: tab) { tab = $0 }
                    .padding(.bottom, 20)
                if ranked.isEmpty {
                    EmptyState(message: "No ranked players yet.").frame(height: 240)
                } else {
                    Podium(top: Array(ranked.prefix(3)), tab: tab, viewerId: viewer.id, onChallenge: onChallenge)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 14)
                    LazyVStack(spacing: 0) {
                        LadderHead(tab: tab)
                        ForEach(Array(ranked.enumerated()), id: \.element.row.id) { i, item in
                            if i > 0 { Rectangle().fill(Palette.line).frame(height: 1) }
                            LadderRowView(item: item, me: item.row.id == viewer.id, onChallenge: onChallenge)
                        }
                    }
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 16)
                }
            }
            .padding(.bottom, 20)
        }
        .defaultScrollAnchor(initialAnchor)
        .refreshable { await loader.refresh() }
    }
}

private struct Chips: View {
    let tab: LeaderboardTab
    let onSelect: (LeaderboardTab) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(LeaderboardTab.allCases, id: \.self) { t in
                    let selected = tab == t
                    Button { onSelect(t) } label: {
                        Text(t.title)
                            .foregroundStyle(selected ? Color.white : Palette.ink2)
                            .textStyle(TypeStyle.chip)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(selected ? Palette.accent : Palette.surface, in: Capsule())
                            .overlay(Capsule().strokeBorder(selected ? Palette.accent : Palette.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, 16)
        }
    }
}

private struct Podium: View {
    let top: [RankedRow]
    let tab: LeaderboardTab
    let viewerId: String
    let onChallenge: ((String) -> Void)?

    var body: some View {
        Card(padding: 0) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Top 3").foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                    Text("The players to beat").foregroundStyle(Palette.muted).textStyle(TypeStyle.cardSub)
                }
                Spacer()
                Tag(text: "PODIUM", background: Color(hex: 0x1FEAB308), color: Palette.gold)
            }
            .padding(EdgeInsets(top: 20, leading: 20, bottom: 14, trailing: 20))
            Rectangle().fill(Palette.line).frame(height: 1)
            VStack(spacing: 10) {
                ForEach(Array(top.enumerated()), id: \.element.row.id) { i, item in
                    row(i, item)
                }
            }
            .padding(16)
        }
    }

    private func row(_ i: Int, _ item: RankedRow) -> some View {
        let shape = RoundedRectangle(cornerRadius: 8)
        return HStack(spacing: 0) {
            Text(String(item.rank))
                .foregroundStyle(medal(item.rank) ?? Palette.dim)
                .textStyle(TextSpec(face: .condensed, size: 30, relativeTo: .title))
                .frame(width: 36)
            Spacer().frame(width: 10)
            Avatar(name: item.row.name, seed: item.row.id, size: .md, ring: i == 0)
            Spacer().frame(width: 12)
            VStack(alignment: .leading, spacing: 0) {
                Text(item.row.name + (item.row.id == viewerId ? "  (you)" : ""))
                    .foregroundStyle(Palette.text)
                    .textStyle(TypeStyle.body(15, weight: 600))
                    .lineLimit(1)
                Text(handleOf(item.row).map { "@\($0)" } ?? (tab.isDoubles ? "Doubles" : "Singles"))
                    .foregroundStyle(Palette.muted)
                    .textStyle(TypeStyle.rowSub)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Spacer().frame(width: 8)
            Text(fmtElo(item.elo))
                .foregroundStyle(Palette.text)
                .textStyle(TextSpec(face: .mono(weight: 700), size: 18, relativeTo: .headline))
            if let onChallenge, item.row.id != viewerId {
                ChallengeButton(name: item.row.name) { onChallenge(item.row.id) }
            }
        }
        .padding(12)
        // highlight is a translucent red wash, so it is laid over the opaque
        // surface rather than replacing it.
        .background(i == 0 ? Palette.highlight : Color.clear, in: shape)
        .background(Palette.surface, in: shape)
        .overlay(shape.strokeBorder(Palette.line, lineWidth: 1))
    }
}

private func handleOf(_ row: LadderRow) -> String? {
    guard let handle = row.handle, !handle.isEmpty else { return nil }
    return handle
}

private let keyStyle = TextSpec(face: .mono(weight: 400), size: 10, trackingEm: 0.1, relativeTo: .caption2)

private struct LadderHead: View {
    let tab: LeaderboardTab

    var body: some View {
        VStack(spacing: 0) {
            Text("\(tab.title) \u{00B7} Full ladder")
                .foregroundStyle(Palette.text)
                .textStyle(TypeStyle.cardTitle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(EdgeInsets(top: 20, leading: 20, bottom: 14, trailing: 20))
            Rectangle().fill(Palette.line).frame(height: 1)
            HStack {
                Text("#  PLAYER").foregroundStyle(Palette.dim).textStyle(keyStyle)
                Spacer()
                Text("ELO").foregroundStyle(Palette.dim).textStyle(keyStyle)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            Rectangle().fill(Palette.line).frame(height: 1)
        }
    }
}

/// One ladder row, drawn inside the card the head opens.
private struct LadderRowView: View {
    let item: RankedRow
    let me: Bool
    let onChallenge: ((String) -> Void)?

    var body: some View {
        HStack(spacing: 0) {
            Text(String(item.rank))
                .foregroundStyle(medal(item.rank) ?? Palette.dim)
                .textStyle(TypeStyle.lrRank)
                .frame(width: 34, alignment: .trailing)
            Spacer().frame(width: 10)
            Avatar(name: item.row.name, seed: item.row.id, size: .sm, ring: me)
            Spacer().frame(width: 10)
            VStack(alignment: .leading, spacing: 0) {
                Text(item.row.name + (me ? "  (you)" : ""))
                    .foregroundStyle(Palette.text)
                    .textStyle(TypeStyle.rowTitle)
                    .lineLimit(1)
                if let handle = handleOf(item.row) {
                    Text("@\(handle)").foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Spacer().frame(width: 8)
            Text(fmtElo(item.elo)).foregroundStyle(Palette.text).textStyle(TypeStyle.lrValue)
            if let onChallenge, !me {
                ChallengeButton(name: item.row.name) { onChallenge(item.row.id) }
            }
        }
        .padding(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 14))
        .background(me ? Palette.highlight : Color.clear)
    }
}

/// The web's crosshair: opens the new-challenge form with this member picked.
private struct ChallengeButton: View {
    let name: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image("tab_challenges")
                .renderingMode(.template)
                .resizable()
                .frame(width: 18, height: 18)
                .foregroundStyle(Palette.muted)
                .frame(width: 48, height: 48)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Challenge \(name)")
    }
}
