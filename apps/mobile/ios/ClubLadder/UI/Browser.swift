import SafariServices
import SwiftUI

// Port of Browser.kt. A club website page the app does not draw opens in the
// member's browser. The website's apple-app-site-association hands some of its
// paths to this app, so handing one of THOSE to the system could land it
// straight back here; such a URL (an upper-case check-in token, a malformed
// challenge id) opens in an in-app Safari view instead, which never re-enters
// universal-link routing. This is the counterpart of Android pinning the
// intent to a browser package.

let noBrowser = "No browser on this phone could open that page."

/// A URL for the in-app Safari sheet.
struct BrowserPage: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// Where a page goes: the in-app sheet (returned) or the system browser. False
/// when the URL cannot be opened at all; nothing is started then.
@MainActor
func openInBrowser(_ text: String, inApp: (BrowserPage) -> Void) async -> Bool {
    guard let url = URL(string: text), url.scheme?.lowercased() == "https" else { return false }
    if LinkRouter.isClaimedPath(text) {
        inApp(BrowserPage(url: url))
        return true
    }
    return await UIApplication.shared.open(url)
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.preferredControlTintColor = UIColor(Palette.accent)
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
