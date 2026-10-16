package com.clubladder.app.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clubladder.app.R
import com.clubladder.app.ui.theme.Barlow
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type
import kotlin.math.sqrt

// The website's shared pieces (globals.css .card, .page-head, .btn, .tag),
// drawn in Compose. Cards carry no outer spacing: a screen spaces them.

@Composable
fun Card(
    modifier: Modifier = Modifier,
    padding: Dp = 20.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = LocalPalette.current
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = p.surface,
        border = BorderStroke(1.dp, p.line),
    ) {
        Column(Modifier.padding(padding), content = content)
    }
}

@Composable
fun Label(text: String) {
    Text(
        text.uppercase(),
        color = LocalPalette.current.muted,
        style = Type.label,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
fun Body(text: String, muted: Boolean = false) {
    val p = LocalPalette.current
    Text(text, color = if (muted) p.muted else p.text, fontSize = 14.sp, lineHeight = 21.sp)
}

/** The page's own title: an optional red eyebrow, the title with its red full stop, a line under it. */
@Composable
fun PageHeader(
    title: String,
    eyebrow: String? = null,
    sub: String? = null,
    padding: PaddingValues = PaddingValues(start = 16.dp, top = 20.dp, end = 16.dp, bottom = 20.dp),
) {
    val p = LocalPalette.current
    Column(Modifier.fillMaxWidth().padding(padding)) {
        if (eyebrow != null) {
            Row(Modifier.padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(width = 24.dp, height = 2.dp).background(p.accent))
                Spacer(Modifier.width(8.dp))
                Text(eyebrow.uppercase(), color = p.accent, style = Type.pageEyebrow)
            }
        }
        Text(
            buildAnnotatedString {
                append(title)
                withStyle(SpanStyle(color = p.accent)) { append(".") }
            },
            color = p.text,
            style = Type.pageTitle,
        )
        if (!sub.isNullOrEmpty()) {
            Text(sub, color = p.muted, style = Type.pageSub, modifier = Modifier.padding(top = 10.dp))
        }
    }
}

/** The header's red tile: faint 135 degree stripes under the white shuttle mark. */
@Composable
fun BrandTile(size: Dp, corner: Dp, markSize: Dp) {
    val p = LocalPalette.current
    val stripe = Color.White.copy(alpha = 0.08f)
    Box(
        Modifier
            .size(size)
            .clip(RoundedCornerShape(corner))
            .background(p.accent)
            .drawBehind {
                val root2 = sqrt(2f)
                val step = 9.dp.toPx() * root2
                val width = 1.dp.toPx()
                // Lines along x + y = c, one every 9dp measured across them.
                var c = 8.5f.dp.toPx() * root2
                while (c < this.size.width + this.size.height) {
                    drawLine(stripe, Offset(c, 0f), Offset(0f, c), strokeWidth = width)
                    c += step
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painterResource(R.drawable.ic_shuttle_mark),
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(markSize),
        )
    }
}

@Composable
fun PrimaryButton(title: String, enabled: Boolean = true, @DrawableRes icon: Int? = null, onClick: () -> Unit) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(8.dp)
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = p.accent,
            contentColor = Color.White,
            disabledContainerColor = p.accent.copy(alpha = 0.55f),
            disabledContentColor = Color.White.copy(alpha = 0.55f),
        ),
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp)
            .then(
                if (enabled) {
                    Modifier.shadow(
                        10.dp,
                        shape,
                        ambientColor = p.accent.copy(alpha = 0.25f),
                        spotColor = p.accent.copy(alpha = 0.5f),
                    )
                } else {
                    Modifier
                },
            ),
    ) {
        if (icon != null) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(title.uppercase(), style = Type.button)
    }
}

@Composable
fun GhostButton(title: String, enabled: Boolean = true, @DrawableRes icon: Int? = null, onClick: () -> Unit) {
    val p = LocalPalette.current
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, p.line),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = Color.Transparent,
            contentColor = p.ink2,
            disabledContentColor = p.ink2.copy(alpha = 0.55f),
        ),
        modifier = Modifier.fillMaxWidth().height(48.dp),
    ) {
        if (icon != null) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
        }
        Text(title.uppercase(), style = Type.button)
    }
}

@Composable
fun TextLink(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Text(
        text,
        color = LocalPalette.current.muted,
        fontSize = 12.sp,
        textDecoration = TextDecoration.Underline,
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
    )
}

/** Something the member should read before going on: the web's red-washed notice box. */
@Composable
fun Notice(text: String) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(8.dp)
    Text(
        text,
        color = p.ink2,
        fontSize = 13.sp,
        lineHeight = 19.sp,
        modifier = Modifier
            .fillMaxWidth()
            .background(p.highlight, shape)
            .border(1.dp, p.redBorder, shape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    )
}

@Composable
fun Alert(text: String) {
    val p = LocalPalette.current
    Text(
        text,
        color = p.danger,
        fontSize = 13.sp,
        lineHeight = 19.sp,
        modifier = Modifier
            .fillMaxWidth()
            .background(p.highlight, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
    )
}

@Composable
fun Tag(text: String, background: Color, color: Color) {
    Text(
        text,
        color = color,
        style = Type.tag,
        modifier = Modifier
            .background(background, RoundedCornerShape(4.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
fun Pill(text: String, background: Color, color: Color) {
    Text(
        text,
        color = color,
        fontFamily = Barlow,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        modifier = Modifier
            .background(background, RoundedCornerShape(999.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

@Composable
fun Loading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = LocalPalette.current.accent)
    }
}

/**
 * A failed read, said as one. On the web a refused read rendered as an empty
 * list for months; here an error is never drawn as "nothing yet".
 */
@Composable
fun ErrorState(message: String, onRetry: (() -> Unit)? = null) {
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, color = p.danger, fontSize = 14.sp, lineHeight = 21.sp, textAlign = TextAlign.Center)
        if (onRetry != null) {
            OutlinedButton(
                onClick = onRetry,
                shape = RoundedCornerShape(8.dp),
                border = BorderStroke(1.dp, p.line),
                contentPadding = PaddingValues(horizontal = 20.dp),
                modifier = Modifier.height(48.dp),
            ) {
                Text("Try again".uppercase(), color = p.ink2, style = Type.button)
            }
        }
    }
}

@Composable
fun EmptyState(message: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(message, color = LocalPalette.current.muted, fontSize = 14.sp, textAlign = TextAlign.Center)
    }
}
