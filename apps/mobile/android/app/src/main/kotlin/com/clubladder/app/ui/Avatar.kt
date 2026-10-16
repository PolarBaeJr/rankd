package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clubladder.app.ui.theme.BarlowCondensed
import com.clubladder.app.ui.theme.LocalPalette

// The web's dark avatar tones (globals.css .avatar[data-tone]), background then ink.
private val tones = listOf(
    Color(0xFF3A2B1F) to Color(0xFFE5B880),
    Color(0xFF22362B) to Color(0xFFA8D5B5),
    Color(0xFF2E2538) to Color(0xFFC6B2E3),
    Color(0xFF3A1420) to Color(0xFFF5A8B4),
    Color(0xFF1E2A3D) to Color(0xFFA8BBD8),
    Color(0xFF32261A) to Color(0xFFD8B88C),
    Color(0xFF2A2824) to Color(0xFFBFB9B0),
)

enum class AvatarSize(val box: Dp, val font: TextUnit) {
    SM(32.dp, 11.sp),
    MD(44.dp, 14.sp),
    XL(96.dp, 30.sp),
}

/**
 * Initials on the member's tone, seeded by player id as on the web. Always
 * initials: a photo would need an image loader the app does not carry.
 */
@Composable
fun Avatar(name: String, seed: String, size: AvatarSize, ring: Boolean = false) {
    val p = LocalPalette.current
    val (bg, fg) = tones[avatarTone(seed) - 1]
    // The ring sits outside the tile, as the web's box-shadow does, so a ringed
    // avatar takes the same room as a plain one.
    val ringColor = p.accent
    Box(
        Modifier
            .size(size.box)
            .drawBehind {
                if (ring) {
                    drawCircle(ringColor, radius = this.size.minDimension / 2 + 1.dp.toPx(), style = Stroke(2.dp.toPx()))
                }
            }
            .background(bg, CircleShape)
            .border(1.dp, p.line, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            avatarInitials(name),
            color = fg,
            fontFamily = BarlowCondensed,
            fontWeight = FontWeight.Bold,
            fontSize = size.font,
            maxLines = 1,
        )
    }
}
