import AuthenticationServices
import UIKit

/// The system passkey sheet. Needs the webcredentials associated domain for the
/// RP ID, so it only works in a signed build with the entitlement; an unsigned
/// simulator build gets a failure, shown as the one passkey message.
///
/// Only a real cancel is silent. `.failed` is NOT treated as one: a broken
/// AASA file or an RP ID mismatch surfaces as exactly that, and reading it as
/// a cancel would make a misconfigured server look like a member who changed
/// their mind. Nothing here is logged: the request and response are sensitive.
struct ASAuthorizationAuthenticator: PasskeyAuthenticator {
    /// Used when the options carry no rpId.
    let fallbackRpId: String?

    func getAssertion(_ requestJson: String) async throws -> AssertionResult {
        guard let options = JSONValue.parse(requestJson), options.isObject,
              let challengeText = options["challenge"]?.string,
              let challenge = base64UrlDecode(challengeText),
              let rpId = options["rpId"]?.string ?? fallbackRpId, !rpId.isEmpty else {
            return .failed("bad_options")
        }
        let allowed = (options["allowCredentials"]?.arrayValue ?? []).compactMap { item in
            item["id"]?.string.flatMap(base64UrlDecode)
        }
        let userVerification = options["userVerification"]?.string ?? "preferred"
        let request = PasskeyRequest(rpId: rpId, challenge: challenge, allowed: allowed, userVerification: userVerification)
        return await withTaskCancellationHandler {
            await AssertionRunner.run(request)
        } onCancel: {
            Task { @MainActor in AssertionRunner.cancelCurrent() }
        }
    }
}

private struct PasskeyRequest: Sendable {
    let rpId: String
    let challenge: Data
    let allowed: [Data]
    let userVerification: String
}

@MainActor
private final class AssertionRunner: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private static var current: AssertionRunner?

    private var continuation: CheckedContinuation<AssertionResult, Never>?
    private var controller: ASAuthorizationController?

    static func run(_ request: PasskeyRequest) async -> AssertionResult {
        await withCheckedContinuation { continuation in
            let runner = AssertionRunner()
            runner.continuation = continuation
            current = runner
            runner.start(request)
        }
    }

    static func cancelCurrent() {
        current?.controller?.cancel()
    }

    private func start(_ request: PasskeyRequest) {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: request.rpId)
        let assertion = provider.createCredentialAssertionRequest(challenge: request.challenge)
        if !request.allowed.isEmpty {
            assertion.allowedCredentials = request.allowed.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        assertion.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreference(
            rawValue: request.userVerification,
        )
        let controller = ASAuthorizationController(authorizationRequests: [assertion])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        controller.performRequests()
    }

    private func finish(_ result: AssertionResult) {
        continuation?.resume(returning: result)
        continuation = nil
        controller = nil
        if AssertionRunner.current === self { AssertionRunner.current = nil }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first ?? ASPresentationAnchor()
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        let result: AssertionResult
        if let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            result = .ok(responseJson(credential))
        } else {
            result = .failed("unexpected_type")
        }
        MainActor.assumeIsolated { finish(result) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        // Unverified until tried on a device: with no passkey the sheet offers
        // other devices, and dismissing it arrives as .canceled, so NoPasskey
        // is probably unreachable here.
        let result: AssertionResult
        if let auth = error as? ASAuthorizationError, auth.code == .canceled {
            result = .cancelled
        } else {
            result = .failed((error as NSError).domain + ":" + String((error as NSError).code))
        }
        MainActor.assumeIsolated { finish(result) }
    }

    /// AuthenticationResponseJSON, in the field order the web client sends.
    private nonisolated func responseJson(_ credential: ASAuthorizationPlatformPublicKeyCredentialAssertion) -> String {
        let id = base64UrlEncode(credential.credentialID)
        var response: [(String, JSONValue)] = [
            ("clientDataJSON", .string(base64UrlEncode(credential.rawClientDataJSON))),
            ("authenticatorData", .string(base64UrlEncode(credential.rawAuthenticatorData ?? Data()))),
            ("signature", .string(base64UrlEncode(credential.signature ?? Data()))),
        ]
        if let handle = credential.userID, !handle.isEmpty {
            response.append(("userHandle", .string(base64UrlEncode(handle))))
        }
        let attachment = credential.attachment == .crossPlatform ? "cross-platform" : "platform"
        return JSONValue.object([
            ("id", .string(id)),
            ("rawId", .string(id)),
            ("type", .string("public-key")),
            ("response", .object(response)),
            ("clientExtensionResults", .object([])),
            ("authenticatorAttachment", .string(attachment)),
        ]).serialized
    }
}
