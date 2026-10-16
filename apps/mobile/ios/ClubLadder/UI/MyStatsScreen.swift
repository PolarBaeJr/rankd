import SwiftUI

// Port of MyStatsScreen.kt. The member's QR card joins it with the scanner.

struct MyStatsScreen: View {
    let viewer: Viewer
    let siteUrl: String?
    let signOut: @Sendable () async -> Void
    @State private var loader: Loader<MyStats>

    init(viewer: Viewer, siteUrl: String?, load: @escaping @Sendable (String) async throws -> MyStats, signOut: @escaping @Sendable () async -> Void) {
        self.viewer = viewer
        self.siteUrl = siteUrl
        self.signOut = signOut
        let id = viewer.id
        _loader = State(initialValue: Loader { try await load(id) })
    }

    private var seasonName: String? {
        if case let .loaded(stats) = loader.state { return stats.seasonName }
        return nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                PageHeader(title: "My stats", sub: seasonName, padding: EdgeInsets(top: 20, leading: 0, bottom: 6, trailing: 0))
                ProfileCard(viewer: viewer)
                // Only a member who can be challenged: anyone else's QR would
                // open a form that clears itself.
                if let siteUrl, isApproved(viewer) { MemberQrCard(siteUrl: siteUrl, playerId: viewer.id) }

                switch loader.state {
                case .loading:
                    LoadingView().frame(height: 160)
                case let .failed(message):
                    ErrorState(message: message) { loader.load() }.frame(height: 200)
                case let .loaded(stats):
                    StatsCards(stats: stats)
                }

                GhostButton(title: "Sign out") {
                    Task { await signOut() }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 20)
        }
        .refreshable { await loader.refresh() }
        .task(id: viewer.id) { loader.load() }
        .onDisappear { loader.cancel() }
    }
}

private struct ProfileCard: View {
    let viewer: Viewer

    var body: some View {
        Card {
            HStack(spacing: 16) {
                Avatar(name: viewer.fullName ?? "Member", seed: viewer.id, size: .xl, ring: true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(viewer.fullName ?? "Member")
                        .foregroundStyle(Palette.text)
                        .textStyle(TextSpec(face: .condensed, size: 26, lineHeight: 28, relativeTo: .title2))
                    if let handle = viewer.handle, !handle.isEmpty {
                        Text("@\(handle)")
                            .foregroundStyle(Palette.muted)
                            .textStyle(TextSpec(face: .mono(weight: 400), size: 12, relativeTo: .caption))
                    }
                    if let code = viewer.memberCode, !code.isEmpty {
                        Text("Member \(code)".uppercased())
                            .foregroundStyle(Palette.muted)
                            .textStyle(TextSpec(face: .mono(weight: 400), size: 12, trackingEm: 0.06, relativeTo: .caption))
                            .padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct StatsCards: View {
    let stats: MyStats

    var body: some View {
        Card {
            SectionLabel(text: "Rating")
            Readouts {
                Readout(label: "Ladder", value: stats.position.map { "#\($0)" }, note: "Not on the ladder")
                ReadoutDivider()
                Readout(label: "Singles", value: fmtElo(stats.singlesElo))
                ReadoutDivider()
                Readout(label: "Doubles", value: fmtElo(stats.doublesElo))
            }
        }

        Card {
            SectionLabel(text: stats.seasonName ?? "This season")
            if let record = stats.record {
                if record.played == 0 {
                    BodyText(text: "No settled matches this season yet.", muted: true)
                } else {
                    Readouts {
                        Readout(label: "Record", value: "\(record.wins)-\(record.losses)")
                        ReadoutDivider()
                        Readout(label: "Singles", value: "\(record.singles.wins)-\(record.singles.losses)")
                        ReadoutDivider()
                        Readout(label: "Doubles", value: "\(record.doubles.wins)-\(record.doubles.losses)")
                    }
                }
            } else {
                BodyText(text: "No season is running.", muted: true)
            }
        }

        Card {
            SectionLabel(text: "Recent matches")
            if stats.recent.isEmpty {
                BodyText(text: stats.seasonName.map { "No matches in \($0) yet." } ?? "No matches yet.", muted: true)
            } else {
                ForEach(stats.recent, id: \.id) { m in
                    Rectangle().fill(Palette.line).frame(height: 1)
                    RecentRow(match: m)
                }
            }
        }
    }
}

private struct RecentRow: View {
    let match: RecentMatch

    var body: some View {
        let delta = fmtDelta(match.delta)
        HStack(spacing: 12) {
            Outcome(outcome: match.outcome)
            VStack(alignment: .leading, spacing: 0) {
                Text((match.type == "singles" ? "Singles" : "Doubles") + (match.score.map { "  \($0)" } ?? ""))
                    .foregroundStyle(Palette.text)
                    .textStyle(TypeStyle.rowTitle)
                    .lineLimit(1)
                Text(match.playedAt.map { String($0.prefix(10)) } ?? "")
                    .foregroundStyle(Palette.muted)
                    .textStyle(TypeStyle.rowSub)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(delta)
                .foregroundStyle(delta.hasPrefix("+") ? Palette.win : delta.hasPrefix("-") ? Palette.danger : Palette.muted)
                .textStyle(TextSpec(face: .mono(weight: 400), size: 14, relativeTo: .subheadline))
        }
        .padding(.vertical, 10)
    }
}

/// The web's result chip: a letter on a wash with a heavier bottom edge.
private struct Outcome: View {
    let outcome: Bool?

    var body: some View {
        let (bg, fg, edge): (Color, Color, Color) = switch outcome {
        case true?: (Palette.winWash, Palette.win, Palette.win)
        case false?: (Palette.highlight, Palette.text, Palette.accent)
        case nil: (Palette.surface2, Palette.dim, Palette.dim)
        }
        Text(outcome.map { $0 ? "W" : "L" } ?? "-")
            .foregroundStyle(fg)
            .textStyle(TextSpec(face: .mono(weight: 700), size: 13, relativeTo: .footnote))
            .frame(width: 24, height: 28)
            .background(bg)
            .overlay(alignment: .bottom) { Rectangle().fill(edge).frame(height: 2) }
            .clipShape(RoundedRectangle(cornerRadius: 2))
    }
}

private struct Readouts<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 0) { content }
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct ReadoutDivider: View {
    var body: some View {
        Rectangle().fill(Palette.line).frame(width: 1).frame(maxHeight: .infinity)
    }
}

private struct Readout: View {
    let label: String
    let value: String?
    var note: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label.uppercased()).foregroundStyle(Palette.muted).textStyle(TypeStyle.statLabel)
            if let value {
                Text(value).foregroundStyle(Palette.text).textStyle(TypeStyle.statValue).lineLimit(1)
            } else if let note {
                Text(note)
                    .foregroundStyle(Palette.muted)
                    .textStyle(TextSpec(face: .mono(weight: 400), size: 11, lineHeight: 15, relativeTo: .caption))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
    }
}
