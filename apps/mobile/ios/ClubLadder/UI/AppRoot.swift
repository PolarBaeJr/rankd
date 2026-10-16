import SwiftUI

struct AppRoot: View {
    let container: AppContainer
    let model: AppModel

    var body: some View {
        Group {
            if let services = container.services {
                switch model.auth {
                case .loading:
                    LoadingView()
                case let .signedOut(notice):
                    SignInScreen(services: services, notice: notice)
                case let .signedIn(session):
                    SignedIn(services: services, userId: session.userId, pendingLink: Bindable(model).pendingLink)
                        .id(session.userId)
                }
            } else {
                ConfigErrorScreen(missing: missingNames)
            }
        }
        .background(Palette.background.ignoresSafeArea())
        .task {
            if let services = container.services { model.start(services) }
        }
    }

    private var missingNames: [String] {
        if case let .missing(names) = container.config { return names }
        return []
    }
}

enum Tab: CaseIterable {
    case feed, leaderboard, challenges, myStats, membership

    var title: String {
        switch self {
        case .feed: return "Feed"
        case .leaderboard: return "Leaderboard"
        case .challenges: return "Challenges"
        case .myStats: return "Stats"
        case .membership: return "Membership"
        }
    }

    var icon: String {
        switch self {
        case .feed: return "tab_feed"
        case .leaderboard: return "tab_leaderboard"
        case .challenges: return "tab_challenges"
        case .myStats: return "tab_stats"
        case .membership: return "tab_membership"
        }
    }
}

/// What the signed-in screens read and do, as closures, so the same screens
/// draw from the live services or, in a debug build, from fixtures.
struct ScreenData: Sendable {
    let siteUrl: String?
    let ladder: @Sendable () async throws -> [LadderRow]
    let myStats: @Sendable (_ playerId: String) async throws -> MyStats
    let feed: @Sendable (Viewer) async throws -> Feed
    let statement: @Sendable (Viewer) async throws -> Statement
    let challenges: @Sendable (_ playerId: String) async throws -> [ChallengeListItem]
    let challenge: @Sendable (_ id: String, _ viewerId: String) async throws -> ChallengeWithMatch?
    /// Nil when the build names no club website: challenges are then read-only.
    let context: (@Sendable () async throws -> AppResult<ChallengeContext>)?
    /// Nil when the build names no club website: nothing can be written.
    let action: (@Sendable (_ name: String, _ args: [JSONValue]) async throws -> ActionOutcome)?
    let signOut: @Sendable () async -> Void

    static func live(_ services: Services) -> ScreenData {
        let postgrest = services.postgrest
        let sessions = services.sessions
        var context: (@Sendable () async throws -> AppResult<ChallengeContext>)?
        var action: (@Sendable (String, [JSONValue]) async throws -> ActionOutcome)?
        if let api = services.appApi {
            context = { try await api.context() }
            action = { try await api.action($0, $1) }
        }
        return ScreenData(
            siteUrl: services.siteUrl,
            ladder: { try await loadLadder(postgrest) },
            myStats: { try await loadMyStats(postgrest, playerId: $0) },
            feed: { try await loadFeed(postgrest, viewer: $0) },
            statement: { try await loadStatement(postgrest, viewer: $0) },
            challenges: { try await loadMyChallenges(postgrest, playerId: $0) },
            challenge: { try await loadChallenge(postgrest, id: $0, viewerId: $1) },
            context: context,
            action: action,
            signOut: { await sessions.signOut() },
        )
    }
}

/// The member's own row, read once per session and shared by every tab.
private struct SignedIn: View {
    let services: Services
    @Binding var pendingLink: String?
    @State private var viewer: Loader<Viewer?>

    init(services: Services, userId: String, pendingLink: Binding<String?>) {
        self.services = services
        _pendingLink = pendingLink
        let postgrest = services.postgrest
        _viewer = State(initialValue: Loader { try await loadViewer(postgrest, userId: userId) })
    }

    var body: some View {
        Group {
            switch viewer.state {
            case .loading:
                LoadingView()
            case let .failed(message):
                ErrorState(message: message) { viewer.load() }
            case let .loaded(data):
                if let data {
                    SignedInTabs(data: .live(services), viewer: data, pendingLink: $pendingLink)
                } else {
                    NoPlayerRow(services: services)
                }
            }
        }
        .task { viewer.load() }
    }
}

/// A session with no player row: an account that never finished signing up, or
/// whose row is gone. Treated like the check after a code: the session is
/// dropped on this phone and the sign-in screen says why.
private struct NoPlayerRow: View {
    let services: Services

    var body: some View {
        LoadingView().task { await services.sessions.signOut(.unfinished) }
    }
}

/// A screen laid over the tabs. One slot, as on Android: opening another
/// replaces it. `list` is the challenges list, for a member whose tab bar has
/// no Challenges tab.
enum Overlay: Hashable {
    case detail(id: String)
    case newChallenge(opponent: String?)
    case checkIn(token: String)
    case list
}

/// The signed-in shell: brand bar, the open tab's screen, the tab bar. Only the
/// open tab's view exists, as on Android, so a closed tab holds no memory, and
/// a tab left for an overlay reads afresh on return.
struct SignedInTabs: View {
    let data: ScreenData
    let viewer: Viewer
    @Binding var pendingLink: String?
    @State private var tab: Tab
    @State private var overlay: Overlay?
    @State private var notice: String?
    @State private var scanning = false
    @State private var page: BrowserPage?
    @State private var refreshKey = 0
    @State private var focusSession: String?

    init(data: ScreenData, viewer: Viewer, pendingLink: Binding<String?>, initialTab: Tab = .feed, initialOverlay: Overlay? = nil) {
        self.data = data
        self.viewer = viewer
        _pendingLink = pendingLink
        _tab = State(initialValue: initialTab)
        _overlay = State(initialValue: initialOverlay)
        #if DEBUG
        _scanning = State(initialValue: DebugPreview.scanOnLaunch)
        #endif
    }

    private var approved: Bool { isApproved(viewer) }
    private var tabs: [Tab] { Tab.allCases.filter { $0 != .challenges || approved } }

    // Scanning needs the website's address to know a club code from any other.
    private var onScan: (() -> Void)? { data.siteUrl == nil ? nil : { scanning = true } }

    private var onChallenge: ((String) -> Void)? {
        guard approved, data.action != nil else { return nil }
        return { id in
            notice = nil
            overlay = .newChallenge(opponent: id)
        }
    }

    var body: some View {
        let shown = tabs.contains(tab) ? tab : .feed
        VStack(spacing: 0) {
            BrandBar(onScan: onScan)
            if let notice {
                VStack(alignment: .leading, spacing: 0) {
                    Notice(text: notice)
                    TextLink(text: "Dismiss") { self.notice = nil }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }
            ZStack {
                Palette.background
                if let overlay {
                    overlayView(overlay).id(overlay)
                } else {
                    screen(shown)
                }
            }
            .frame(maxHeight: .infinity)
            TabBar(tabs: tabs, selected: overlay == nil ? shown : nil) {
                tab = $0
                overlay = nil
                notice = nil
            }
        }
        .background(Palette.background.ignoresSafeArea())
        .fullScreenCover(isPresented: $scanning) {
            ScannerView { outcome in
                scanning = false
                switch outcome {
                case .cancelled: break
                case .unavailable: notice = scanUnavailable
                case let .scanned(text): route(LinkRouter.parse(text, siteUrl: data.siteUrl), fromScanner: true)
                }
            }
        }
        .sheet(item: $page) { SafariView(url: $0.url).ignoresSafeArea() }
        // A link iOS handed over, including one that arrived while signed out.
        // A link that is not the website's goes to the browser.
        .task(id: pendingLink) {
            guard let url = pendingLink else { return }
            pendingLink = nil
            let parsed = LinkRouter.parse(url, siteUrl: data.siteUrl)
            if parsed == .notOurs { browse(url) } else { route(parsed, fromScanner: false) }
        }
    }

    private func route(_ route: LinkRoute, fromScanner: Bool) {
        notice = nil
        switch route {
        case let .tab(target, sessionId):
            overlay = nil
            let wanted = Tab(target)
            if tabs.contains(wanted) { tab = wanted } else { overlay = .list }
            if wanted == .feed { focusSession = sessionId }
        case let .challengeDetail(id):
            overlay = approved ? .detail(id: id) : .list
        case let .newChallenge(opponentId):
            overlay = approved ? .newChallenge(opponent: opponentId) : .list
        case let .checkIn(token):
            overlay = .checkIn(token: token)
        case let .openInBrowser(url):
            browse(url)
        case .notOurs:
            if fromScanner { notice = scanNotOurs }
        }
    }

    private func open(_ link: FeedLink) {
        switch link {
        case .myStats: route(.tab(.myStats), fromScanner: false)
        case .membership: route(.tab(.membership), fromScanner: false)
        case .challenges: route(.tab(.challenges), fromScanner: false)
        case .newChallenge: route(.newChallenge(opponentId: nil), fromScanner: false)
        case let .challenge(id): route(.challengeDetail(id: id), fromScanner: false)
        case let .web(path):
            if let site = data.siteUrl {
                let base = site.hasSuffix("/") ? String(site.dropLast()) : site
                route(.openInBrowser(url: base + path), fromScanner: false)
            }
        }
    }

    private func browse(_ url: String) {
        Task {
            if !(await openInBrowser(url) { page = $0 }) { notice = noBrowser }
        }
    }

    @ViewBuilder
    private func screen(_ tab: Tab) -> some View {
        switch tab {
        case .feed:
            FeedScreen(
                viewer: viewer,
                load: data.feed,
                refreshKey: refreshKey,
                focusSession: $focusSession,
                onScan: onScan,
                canBrowse: data.siteUrl != nil,
                onLink: open,
            )
        case .leaderboard:
            LeaderboardScreen(viewer: viewer, load: data.ladder, onChallenge: onChallenge)
        case .challenges:
            ChallengesScreen(
                data: data,
                viewer: viewer,
                onOpen: { overlay = .detail(id: $0) },
                onNew: { overlay = .newChallenge(opponent: nil) },
            )
        case .myStats:
            MyStatsScreen(viewer: viewer, siteUrl: data.siteUrl, load: data.myStats, signOut: data.signOut)
        case .membership:
            MembershipScreen(viewer: viewer, load: data.statement)
        }
    }

    @ViewBuilder
    private func overlayView(_ overlay: Overlay) -> some View {
        switch overlay {
        case let .detail(id):
            OverlayFrame(back: "Back to challenges", onBack: { self.overlay = nil }) {
                ChallengeDetailScreen(data: data, viewer: viewer, challengeId: id)
            }
        case let .newChallenge(opponent):
            OverlayFrame(back: "Back to challenges", onBack: { self.overlay = nil }) {
                NewChallengeScreen(data: data, viewer: viewer, initialOpponentId: opponent) {
                    self.overlay = nil
                    tab = .challenges
                    notice = "Challenge sent!"
                }
            }
        case let .checkIn(token):
            OverlayFrame(back: "Back", onBack: { self.overlay = nil }) {
                CheckInScreen(token: token, action: data.action) {
                    self.overlay = nil
                    tab = .feed
                    refreshKey += 1
                }
            }
        case .list:
            OverlayFrame(back: "Back", onBack: { self.overlay = nil }) {
                ChallengesScreen(data: data, viewer: viewer, onOpen: { _ in }, onNew: {})
            }
        }
    }
}

private extension Tab {
    init(_ target: TabTarget) {
        switch target {
        case .feed: self = .feed
        case .leaderboard: self = .leaderboard
        case .challenges: self = .challenges
        case .myStats: self = .myStats
        case .membership: self = .membership
        }
    }
}

/// A screen over the tabs: the web's "Back to ..." link above it.
private struct OverlayFrame<Content: View>: View {
    let back: String
    let onBack: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextLink(text: back, action: onBack).padding(.horizontal, 12)
            content.frame(maxHeight: .infinity)
        }
    }
}

/// The site header: the red tile and the club's name. Each page carries its own title.
private struct BrandBar: View {
    let onScan: (() -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                BrandTile(size: 30, corner: 8, markSize: 20)
                Text("Club Ladder")
                    .foregroundStyle(Palette.text)
                    .textStyle(TypeStyle.brand)
                Spacer()
                if let onScan {
                    Button(action: onScan) {
                        Image("scan")
                            .renderingMode(.template)
                            .resizable()
                            .frame(width: 22, height: 22)
                            .foregroundStyle(Palette.ink2)
                            .frame(width: 48, height: 48)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Scan a club QR code")
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 4)
            .padding(.vertical, 12)
            Rectangle().fill(Palette.line).frame(height: 1)
        }
        .background(Palette.background)
    }
}

/// The web's mobile tab bar: line icons over small labels, red for the open tab.
private struct TabBar: View {
    let tabs: [Tab]
    let selected: Tab?
    let onSelect: (Tab) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Palette.line).frame(height: 1)
            HStack(spacing: 0) {
                ForEach(tabs, id: \.self) { t in
                    let isSelected = selected == t
                    let color = isSelected ? Palette.accent : Palette.muted
                    Button { onSelect(t) } label: {
                        VStack(spacing: 3) {
                            Image(t.icon)
                                .renderingMode(.template)
                                .resizable()
                                .frame(width: 20, height: 20)
                            Text(t.title)
                                .textStyle(TypeStyle.tabLabel)
                                .lineLimit(1)
                        }
                        .foregroundStyle(color)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
        }
        .background(Palette.background.ignoresSafeArea(edges: .bottom))
    }
}
