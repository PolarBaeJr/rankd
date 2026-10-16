import SwiftUI

// Port of CheckInScreen.kt (apps/player/src/app/checkin/[token]/checkin-client.tsx):
// a door QR scanned in the app, or opened from a link, checks the member in
// through the website's checkInWithToken once they confirm. The confirm step
// matters because any app can open an clubladder:// link. The call is
// idempotent on the server;
// a run cut short records nothing, so the screen asks again when it next
// appears rather than showing a failure it never had.

private enum CheckInResult: Equatable {
    case checkedIn
    case already
    case error(String)
}

struct CheckInScreen: View {
    let token: String
    let action: (@Sendable (String, [JSONValue]) async throws -> ActionOutcome)?
    let onDone: () -> Void
    @State private var confirmed = false
    @State private var result: CheckInResult?

    var body: some View {
        ZStack(alignment: .top) {
            Palette.background
            Card(padding: 28) {
                VStack(spacing: 8) {
                    switch result {
                    case nil where !confirmed:
                        Heading(text: "Check in to this session?")
                        Text("This marks you as here at today's session.")
                            .foregroundStyle(Palette.muted)
                            .textStyle(TypeStyle.pageSub)
                            .multilineTextAlignment(.center)
                        PrimaryButton(title: "Check in") { confirmed = true }.padding(.top, 12)
                    case nil:
                        ProgressView().tint(Palette.muted).frame(width: 28, height: 28)
                        Heading(text: "Checking you in...")
                    case .checkedIn?:
                        Heading(text: "You're checked in")
                        Text("Have a good session.").foregroundStyle(Palette.muted).textStyle(TypeStyle.pageSub)
                    case .already?:
                        Heading(text: "Already checked in")
                        Text("No need to scan again.").foregroundStyle(Palette.muted).textStyle(TypeStyle.pageSub)
                    case let .error(message)?:
                        Heading(text: "Couldn't check you in")
                        AlertBox(text: message)
                    }
                    GhostButton(title: confirmed ? "Go to sessions" : "Not now", action: onDone)
                        .padding(.top, confirmed ? 12 : 0)
                }
                .frame(maxWidth: .infinity)
            }
            .padding(.top, 40)
            .padding(16)
        }
        .onChange(of: token) {
            confirmed = false
            result = nil
        }
        .task(id: "\(token) \(confirmed)") {
            guard confirmed, result == nil else { return }
            guard let action else {
                result = .error(readOnlyNotice)
                return
            }
            guard let outcome = try? await runAction(action, "checkInWithToken", [.string(token)]) else { return }
            switch outcome {
            case let .ok(data):
                result = data?["alreadyCheckedIn"]?.bool == true ? .already : .checkedIn
            case let .refused(message), let .failed(message):
                result = .error(message)
            }
        }
    }
}

private struct Heading: View {
    let text: String

    var body: some View {
        Text(text)
            .foregroundStyle(Palette.text)
            .textStyle(TextSpec(face: .condensed, size: 22, relativeTo: .title3))
            .multilineTextAlignment(.center)
    }
}
