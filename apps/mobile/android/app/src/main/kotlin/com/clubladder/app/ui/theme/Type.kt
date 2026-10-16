package com.clubladder.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.clubladder.app.R

// The website's three faces (apps/player/src/app/layout.tsx), latin only.
// Anything outside latin falls back to the system font glyph by glyph. Barlow
// ships 400, 600 and 700; a 500 request lands on 400. JetBrains Mono is one
// variable file, so every weight is a setting on it rather than another file.
// Material's default tracking is dropped: the site sets Barlow untracked.

val Barlow = FontFamily(
    Font(R.font.barlow_regular, FontWeight.Normal),
    Font(R.font.barlow_semibold, FontWeight.SemiBold),
    Font(R.font.barlow_bold, FontWeight.Bold),
)

val BarlowCondensed = FontFamily(
    Font(R.font.barlow_condensed_bold, FontWeight.Bold),
)

// Resource fonts with variation settings are still marked experimental.
@OptIn(ExperimentalTextApi::class)
private fun mono(weight: Int) = Font(
    R.font.jetbrains_mono,
    FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

val JetBrainsMono = FontFamily(mono(400), mono(500), mono(600), mono(700))

private val base = Typography()

val AppTypography = Typography(
    displayLarge = base.displayLarge.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    displayMedium = base.displayMedium.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    displaySmall = base.displaySmall.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    headlineLarge = base.headlineLarge.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    headlineMedium = base.headlineMedium.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    headlineSmall = base.headlineSmall.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    titleLarge = base.titleLarge.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    titleMedium = base.titleMedium.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    titleSmall = base.titleSmall.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    bodyLarge = base.bodyLarge.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    bodyMedium = base.bodyMedium.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    bodySmall = base.bodySmall.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    labelLarge = base.labelLarge.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    labelMedium = base.labelMedium.copy(fontFamily = Barlow, letterSpacing = 0.sp),
    labelSmall = base.labelSmall.copy(fontFamily = Barlow, letterSpacing = 0.sp),
)

/** The website's named text treatments. Colour and upper case are set where they are used. */
object Type {
    val pageTitle = TextStyle(
        fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 34.sp, lineHeight = 34.sp,
        letterSpacing = (-0.015).em,
    )
    val pageEyebrow = TextStyle(
        fontFamily = JetBrainsMono, fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.12.em,
    )
    val pageSub = TextStyle(fontFamily = Barlow, fontSize = 14.sp, lineHeight = 21.sp)
    val cardTitle = TextStyle(
        fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 18.sp, letterSpacing = (-0.01).em,
    )
    val cardSub = TextStyle(fontFamily = Barlow, fontSize = 13.sp)
    val label = TextStyle(
        fontFamily = JetBrainsMono, fontWeight = FontWeight.Medium, fontSize = 10.sp, letterSpacing = 0.16.em,
    )
    val statLabel = TextStyle(fontFamily = JetBrainsMono, fontSize = 10.sp, letterSpacing = 0.1.em)
    val statValue = TextStyle(
        fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 28.sp,
        letterSpacing = (-0.02).em,
    )
    val figure = TextStyle(
        fontFamily = JetBrainsMono, fontWeight = FontWeight.Bold, fontSize = 46.sp, letterSpacing = (-0.03).em,
    )
    val button = TextStyle(
        fontFamily = Barlow, fontWeight = FontWeight.Bold, fontSize = 14.sp, letterSpacing = 0.16.em,
    )
    val tag = TextStyle(
        fontFamily = JetBrainsMono, fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.02.em,
    )
    val chip = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.Medium, fontSize = 13.sp)
    val rowTitle = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
    val rowSub = TextStyle(fontFamily = JetBrainsMono, fontSize = 11.sp)
    val lrRank = TextStyle(fontFamily = JetBrainsMono, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
    val lrValue = TextStyle(fontFamily = JetBrainsMono, fontWeight = FontWeight.Bold, fontSize = 16.sp)
    val sessDate = TextStyle(fontFamily = JetBrainsMono, fontSize = 11.sp, letterSpacing = 0.14.em)
    val sessTime = TextStyle(fontFamily = JetBrainsMono, fontSize = 15.sp)
    val sessMeta = TextStyle(fontFamily = JetBrainsMono, fontSize = 12.sp)
    val brand = TextStyle(
        fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 15.sp, letterSpacing = (-0.01).em,
    )
    val signinTitle = TextStyle(
        fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 30.sp, lineHeight = 30.sp,
        letterSpacing = 0.2.em,
    )
    val signinHeading = TextStyle(
        fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 26.sp, letterSpacing = (-0.02).em,
    )
    val tabLabel = TextStyle(fontFamily = Barlow, fontWeight = FontWeight.Medium, fontSize = 10.sp)
}
