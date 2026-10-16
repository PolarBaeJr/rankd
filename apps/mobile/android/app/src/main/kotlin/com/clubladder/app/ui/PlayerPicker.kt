package com.clubladder.app.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clubladder.app.data.Opponent
import com.clubladder.app.ui.theme.JetBrainsMono
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type
import kotlin.math.roundToLong

// The web's PlayerPicker (apps/player/src/components/player-picker.tsx): one
// slot of the new-challenge form, and a searchable list over the opponents the
// website said may be challenged. The Elo trails only when the member shows it.

fun eloText(elo: Double?): String? = elo?.roundToLong()?.toString()

/** Name or handle, case aside, as the web filters. */
fun matchesSearch(o: Opponent, query: String): Boolean {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return true
    return o.fullName.lowercase().contains(q) || (o.handle?.lowercase()?.contains(q) ?: false)
}

@Composable
fun PlayerSlot(label: String, selected: Opponent?, trailing: String?, placeholder: String, onClick: () -> Unit) {
    val p = LocalPalette.current
    Column {
        Label(label)
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .border(1.dp, p.line, RoundedCornerShape(8.dp))
                .clickable(role = Role.Button, onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (selected == null) {
                Text(placeholder, color = p.placeholder, fontSize = 14.sp, modifier = Modifier.weight(1f))
            } else {
                Avatar(selected.fullName, selected.id, AvatarSize.SM)
                Spacer(Modifier.width(10.dp))
                Text(
                    selected.fullName,
                    color = p.text,
                    style = Type.rowTitle,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                trailing?.let { Text(it, color = p.muted, fontFamily = JetBrainsMono, fontSize = 12.sp) }
            }
        }
    }
}

@Composable
fun PlayerPickerDialog(
    title: String,
    players: List<Opponent>,
    trailing: (Opponent) -> String?,
    allowClear: Boolean,
    onPick: (Opponent?) -> Unit,
    onDismiss: () -> Unit,
) {
    val p = LocalPalette.current
    var query by remember { mutableStateOf("") }
    val shown = players.filter { matchesSearch(it, query) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = p.surface,
        title = { Text(title, color = p.text, style = Type.cardTitle) },
        text = {
            Column {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("Search by name or handle") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (shown.isEmpty()) {
                    Text("No players match.", color = p.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 14.dp))
                }
                LazyColumn(Modifier.padding(top = 8.dp).heightIn(max = 360.dp)) {
                    items(shown, key = { it.id }) { o ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 52.dp)
                                .clickable(role = Role.Button) { onPick(o) }
                                .padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Avatar(o.fullName, o.id, AvatarSize.SM)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(o.fullName, color = p.text, style = Type.rowTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                o.handle?.takeIf { it.isNotEmpty() }?.let {
                                    Text("@$it", color = p.muted, style = Type.rowSub, maxLines = 1)
                                }
                            }
                            trailing(o)?.let { Text(it, color = p.muted, fontFamily = JetBrainsMono, fontSize = 12.sp) }
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (allowClear) TextButton(onClick = { onPick(null) }) { Text("Clear", color = p.ink2) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close", color = p.ink2) } },
    )
}
