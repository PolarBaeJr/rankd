import SwiftUI

@main
struct ClubLadderApp: App {
    // Hosted unit tests launch the app too: build nothing then, so no test
    // touches the Keychain session or the network through the app.
    private static let underTest = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    // A debug preview launch builds no services either (see DebugPreview).
    #if DEBUG
    private static let previewing = DebugPreview.tab != nil
    #else
    private static let previewing = false
    #endif

    @State private var container: AppContainer? = underTest || previewing ? nil : AppContainer()
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if !Self.underTest, let tab = DebugPreview.tab {
                DebugPreview.root(tab)
            } else {
                app
            }
            #else
            app
            #endif
        }
    }

    @ViewBuilder
    private var app: some View {
        if let container {
            AppRoot(container: container, model: model)
                .preferredColorScheme(.dark)
                .onOpenURL { takeLink($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { takeLink(url) }
                }
                .onChange(of: scenePhase) { _, phase in
                    // A token that expired while the app was in the
                    // background is refreshed on return, before the first
                    // screen's read needs it.
                    guard phase == .active, let services = container.services else { return }
                    Task { _ = try? await services.sessions.validAccessToken() }
                }
        } else {
            Color.black
        }
    }

    /// A link the system handed over, queued for the signed-in screens to
    /// route: an https universal link, or one on the app's own scheme read as
    /// the same page of the build's website.
    private func takeLink(_ url: URL) {
        if url.scheme?.lowercased() == LinkRouter.appScheme {
            model.pendingLink = LinkRouter.fromAppScheme(url.absoluteString, siteUrl: container?.services?.siteUrl)
            return
        }
        guard url.scheme?.lowercased() == "https" else { return }
        model.pendingLink = url.absoluteString
    }
}
