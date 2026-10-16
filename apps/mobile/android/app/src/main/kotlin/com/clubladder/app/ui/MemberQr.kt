package com.clubladder.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type
import io.nayuki.qrcodegen.QrCode

/**
 * The member's challenge QR, the same link the website's profile QR encodes
 * (packages/shared/src/utils/challenge-qr.ts): scanning it opens the new
 * challenge form with this member picked. Never an authorisation; the
 * challenge still goes through createChallenge and the club's rules.
 */
fun challengeQrUrl(siteUrl: String, playerId: String): String = "$siteUrl/challenges/new?opponent=$playerId"

@Composable
fun MemberQrCard(siteUrl: String, playerId: String) {
    val p = LocalPalette.current
    val qr = remember(siteUrl, playerId) { QrCode.encodeText(challengeQrUrl(siteUrl, playerId), QrCode.Ecc.MEDIUM) }
    Card {
        Text("Your challenge QR", color = p.text, style = Type.cardTitle)
        Text(
            "Anyone in the club can scan this to challenge you.",
            color = p.muted,
            style = Type.cardSub,
            modifier = Modifier.padding(top = 2.dp, bottom = 14.dp),
        )
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            // Black modules on white with a four-module quiet zone, whatever the
            // app's own dark theme: scanners expect dark on light.
            Canvas(
                Modifier
                    .widthIn(max = 240.dp)
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    .background(Color.White, RoundedCornerShape(8.dp))
                    .semantics { contentDescription = "Your challenge QR code" },
            ) {
                val quiet = 4
                val cells = qr.size + quiet * 2
                val cell = size.width / cells
                for (y in 0 until qr.size) {
                    for (x in 0 until qr.size) {
                        if (qr.getModule(x, y)) {
                            drawRect(
                                Color.Black,
                                topLeft = Offset((x + quiet) * cell, (y + quiet) * cell),
                                // A hair over one cell, so no seam shows between neighbours.
                                size = Size(cell + 0.5f, cell + 0.5f),
                            )
                        }
                    }
                }
            }
        }
    }
}
