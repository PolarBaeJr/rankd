package com.clubladder.app.ui

import android.content.Context
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

// Google's code scanner: Play services draws the camera screen and hands back
// only the code, so the app holds no CAMERA permission and ships no scanning
// model of its own. On a phone without Play services, or before the scanner
// module has downloaded, the scan fails, and the member is pointed at the
// camera app instead: a club QR opens here through App Links anyway.

sealed interface ScanOutcome {
    data class Scanned(val text: String) : ScanOutcome
    data object Cancelled : ScanOutcome
    data object Unavailable : ScanOutcome
}

const val SCAN_UNAVAILABLE =
    "Scanning is not available on this phone. Point your camera app at the code instead; it opens here."

const val SCAN_NOT_OURS = "This QR code is not from the club website."

suspend fun scanQrCode(context: Context): ScanOutcome = suspendCancellableCoroutine { cont ->
    val options = GmsBarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .enableAutoZoom()
        .build()
    val finish = { outcome: ScanOutcome -> if (cont.isActive) cont.resume(outcome) }
    try {
        GmsBarcodeScanning.getClient(context, options).startScan()
            .addOnSuccessListener { code ->
                finish(code.rawValue?.let { ScanOutcome.Scanned(it) } ?: ScanOutcome.Unavailable)
            }
            .addOnCanceledListener { finish(ScanOutcome.Cancelled) }
            .addOnFailureListener { finish(ScanOutcome.Unavailable) }
    } catch (e: RuntimeException) {
        finish(ScanOutcome.Unavailable)
    }
}
