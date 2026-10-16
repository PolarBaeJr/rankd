package com.clubladder.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import com.clubladder.app.shared.CalendarTone

// The club website's dark theme tokens (apps/player/src/app/globals.css). The
// app is dark only.

@Immutable
data class Palette(
    val background: Color,
    val surface: Color,
    val surface2: Color,
    val surface3: Color,
    val line: Color,
    val line2: Color,
    val text: Color,
    val ink2: Color,
    val muted: Color,
    val dim: Color,
    val faint: Color,
    val placeholder: Color,
    val accent: Color,
    val redInk: Color,
    val redBorder: Color,
    val danger: Color,
    val highlight: Color,
    val win: Color,
    val winWash: Color,
    val warning: Color,
    val gold: Color,
    val silver: Color,
    val bronze: Color,
)

private val Dark = Palette(
    background = Color(0xFF0A0A0A),
    surface = Color(0xFF111111),
    surface2 = Color(0xFF1A1A1A),
    surface3 = Color(0xFF232323),
    line = Color(0x14FFFFFF),
    line2 = Color(0x24FFFFFF),
    text = Color(0xFFF0F0F0),
    ink2 = Color(0xFFC8C8C8),
    muted = Color(0xFF888888),
    dim = Color(0xFF666666),
    faint = Color(0xFF444444),
    placeholder = Color(0xFF565656),
    accent = Color(0xFFCC0000),
    redInk = Color(0xFFA30000),
    redBorder = Color(0x4DCC0000),
    danger = Color(0xFFCC0000),
    highlight = Color(0x1ACC0000),
    win = Color(0xFF4ADE80),
    winWash = Color(0x1A4ADE80),
    warning = Color(0xFFFBBF24),
    gold = Color(0xFFEAB308),
    silver = Color(0xFFBCBDC0),
    bronze = Color(0xFFC68A55),
)

val LocalPalette = staticCompositionLocalOf { Dark }

/** The calendar's tone marks, as globals.css colours them. */
fun Palette.tone(tone: CalendarTone): Color = when (tone) {
    CalendarTone.OPEN -> win
    CalendarTone.CLOSED -> line2
    CalendarTone.CLUB -> gold
    CalendarTone.TOURNAMENT -> ink2
    CalendarTone.CANCELLED -> line2
}

@Composable
fun AppTheme(content: @Composable () -> Unit) {
    val p = Dark
    val scheme = darkColorScheme().copy(
        primary = p.accent,
        onPrimary = Color.White,
        background = p.background,
        onBackground = p.text,
        surface = p.surface,
        onSurface = p.text,
        surfaceVariant = p.surface2,
        onSurfaceVariant = p.muted,
        surfaceContainer = p.surface,
        surfaceContainerHigh = p.surface2,
        surfaceContainerHighest = p.surface3,
        secondaryContainer = p.highlight,
        onSecondaryContainer = p.text,
        outline = p.line,
        outlineVariant = p.line,
        error = p.danger,
    )
    CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(colorScheme = scheme, typography = AppTypography, content = content)
    }
}
