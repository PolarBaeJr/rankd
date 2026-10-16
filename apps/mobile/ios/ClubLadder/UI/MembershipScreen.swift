import SwiftUI

// Port of MembershipScreen.kt. The phone shows the statement; receipts are
// sent from the website.

struct MembershipScreen: View {
    let viewer: Viewer
    let load: @Sendable (Viewer) async throws -> Statement

    var body: some View {
        if isApproved(viewer) {
            StatementView(viewer: viewer, load: load)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(title: "Membership", padding: EdgeInsets(top: 20, leading: 0, bottom: 20, trailing: 0))
                Card { BodyText(text: "Your statement appears here once your membership is approved.", muted: true) }
                Spacer()
            }
            .padding(.horizontal, 16)
        }
    }
}

private struct StatementView: View {
    let viewer: Viewer
    @State private var loader: Loader<Statement>

    init(viewer: Viewer, load: @escaping @Sendable (Viewer) async throws -> Statement) {
        self.viewer = viewer
        _loader = State(initialValue: Loader { try await load(viewer) })
    }

    var body: some View {
        Group {
            switch loader.state {
            case .loading:
                VStack(spacing: 0) {
                    PageHeader(title: "Membership")
                    LoadingView()
                }
            case let .failed(message):
                VStack(spacing: 0) {
                    PageHeader(title: "Membership")
                    ErrorState(message: message) { loader.load() }
                }
            case let .loaded(statement):
                content(statement)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .task(id: viewer.id) { loader.load() }
        .onDisappear { loader.cancel() }
    }

    private func content(_ statement: Statement) -> some View {
        let summary = statement.summary
        let headline = statementHeadline(summary)
        let (bg, fg): (Color, Color) = switch headlineBadge(summary).tone {
        case .success: (Palette.win.opacity(0.2), Palette.win)
        case .warning: (Palette.warning.opacity(0.2), Palette.warning)
        case .neutral: (Palette.line2, Palette.muted)
        }
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                PageHeader(title: "Membership", sub: statement.season?.name, padding: EdgeInsets(top: 20, leading: 0, bottom: 6, trailing: 0))

                Card {
                    SectionLabel(text: "Outstanding")
                    HStack(spacing: 12) {
                        Text(headline.amount).foregroundStyle(Palette.text).textStyle(TypeStyle.figure)
                        Pill(text: headline.label, background: bg, color: fg)
                    }
                    .padding(.top, 6)
                    if summary.unknownCount > 0 {
                        Text("Plus \(summary.unknownCount) \(summary.unknownCount == 1 ? "entry" : "entries") with no price recorded yet.")
                            .foregroundStyle(Palette.muted)
                            .textStyle(TypeStyle.body(13, lineHeight: 19))
                            .padding(.top, 14)
                    }
                }

                if !summary.outstanding.isEmpty {
                    Card {
                        SectionLabel(text: "To pay")
                        ForEach(summary.outstanding, id: \.key) { OwedRow(line: $0) }
                        BodyText(text: "Send a payment receipt from the Membership page on the club website.", muted: true)
                            .padding(.top, 8)
                    }
                }

                Card {
                    SectionLabel(text: "Receipts")
                    if summary.receipts.isEmpty {
                        BodyText(text: "No payments recorded yet.", muted: true)
                    } else {
                        ForEach(summary.receipts, id: \.key) { ReceiptRow(line: $0) }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 20)
        }
        .refreshable { await loader.refresh() }
    }
}

private struct OwedRow: View {
    let line: FeeLine

    var body: some View {
        Rectangle().fill(Palette.line).frame(height: 1)
        HStack(spacing: 12) {
            Text(line.name).foregroundStyle(Palette.ink2).textStyle(TypeStyle.body(14)).frame(maxWidth: .infinity, alignment: .leading)
            Text(money(line.owedCents))
                .foregroundStyle(Palette.text)
                .textStyle(TextSpec(face: .mono(weight: 400), size: 14, relativeTo: .subheadline))
        }
        .padding(.vertical, 8)
    }
}

private struct ReceiptRow: View {
    let line: FeeLine

    var body: some View {
        Rectangle().fill(Palette.line).frame(height: 1)
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                Text(line.name).foregroundStyle(Palette.text).textStyle(TypeStyle.body(15))
                if let day = line.paidAt.map({ String($0.prefix(10)) }), !day.isEmpty {
                    Text(day.uppercased())
                        .foregroundStyle(Palette.muted)
                        .textStyle(TextSpec(face: .mono(weight: 400), size: 10, trackingEm: 0.1, relativeTo: .caption2))
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(line.waived ? "Waived" : money(line.recordedCents))
                .foregroundStyle(Palette.text)
                .textStyle(TextSpec(face: .mono(weight: 400), size: 15, relativeTo: .callout))
        }
        .padding(.vertical, 14)
    }
}
