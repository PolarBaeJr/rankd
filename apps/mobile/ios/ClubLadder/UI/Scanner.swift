import AVFoundation
import SwiftUI
import VisionKit

// The QR scanner: VisionKit's DataScannerViewController, the system's own
// camera reader, so the app ships no scanning model of its own. Android's copy
// and outcomes are kept (Scanner.kt). A phone without the hardware, or the
// simulator, which has no camera, gets SCAN_UNAVAILABLE; a debug build offers a
// paste field there instead, so routing can still be tried.

enum ScanOutcome: Equatable, Sendable {
    case scanned(String)
    case cancelled
    case unavailable
}

let scanUnavailable =
    "Scanning is not available on this phone. Point your camera app at the code instead; it opens here."

let scanNotOurs = "This QR code is not from the club website."

let cameraOff = "Camera access is off for Club Ladder. Turn it on in Settings to scan a code."

/// A full-screen cover. It reports once: a code, a cancel, or no scanner.
struct ScannerView: View {
    let onResult: (ScanOutcome) -> Void

    private enum Phase { case checking, denied, unavailable, scanning }
    @State private var phase: Phase = .checking
    @State private var reported = false

    var body: some View {
        ZStack {
            Palette.background.ignoresSafeArea()
            switch phase {
            case .checking:
                LoadingView()
            case .scanning:
                DataScanner { finish(.scanned($0)) }.ignoresSafeArea()
            case .denied:
                message(cameraOff) {
                    PrimaryButton(title: "Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            case .unavailable:
                #if DEBUG
                DebugPasteCode { finish(.scanned($0)) }
                #else
                LoadingView()
                #endif
            }
        }
        .overlay(alignment: .topTrailing) {
            SheetButton(title: "Cancel", color: Palette.ink2) { finish(.cancelled) }.padding(.trailing, 8)
        }
        .task { await check() }
    }

    private func message(_ text: String, @ViewBuilder action: () -> some View) -> some View {
        VStack(spacing: 16) {
            Text(text)
                .foregroundStyle(Palette.text)
                .textStyle(TypeStyle.body(15, lineHeight: 22))
                .multilineTextAlignment(.center)
            action()
        }
        .padding(24)
    }

    private func finish(_ outcome: ScanOutcome) {
        guard !reported else { return }
        reported = true
        onResult(outcome)
    }

    /// Hardware first, so a device that cannot scan never asks for the camera.
    private func check() async {
        guard DataScannerViewController.isSupported else { return unavailable() }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            if !granted { phase = .denied; return }
        case .denied, .restricted:
            phase = .denied
            return
        default:
            break
        }
        if DataScannerViewController.isAvailable { phase = .scanning } else { unavailable() }
    }

    private func unavailable() {
        #if DEBUG
        phase = .unavailable
        #else
        finish(.unavailable)
        #endif
    }
}

private struct DataScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true,
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !context.coordinator.started {
            context.coordinator.started = true
            try? scanner.startScanning()
        }
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        var started = false
        private var done = false

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        /// The first QR payload wins; the scanner keeps reporting until stopped.
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in addedItems {
                if case let .barcode(code) = item, let text = code.payloadStringValue {
                    done = true
                    dataScanner.stopScanning()
                    onCode(text)
                    return
                }
            }
        }
    }
}

#if DEBUG
/// Debug builds only: the simulator has no camera, so a code's text can be pasted instead.
private struct DebugPasteCode: View {
    let onCode: (String) -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(scanUnavailable).foregroundStyle(Palette.muted).textStyle(TypeStyle.body(13, lineHeight: 19))
            SectionLabel(text: "Paste a code (debug build)")
            TextField("", text: $text, prompt: Text("https://...").foregroundStyle(Palette.placeholder))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .foregroundStyle(Palette.text)
                .textStyle(TypeStyle.body(14))
                .fieldBox(focused: false)
            PrimaryButton(title: "Use this code", enabled: !text.trimmingCharacters(in: .whitespaces).isEmpty) { onCode(text) }
        }
        .padding(.horizontal, 20)
        .padding(.top, 64)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}
#endif
