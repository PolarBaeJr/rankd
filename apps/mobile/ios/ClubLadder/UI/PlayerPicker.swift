import SwiftUI

// Port of PlayerPicker.kt (apps/player/src/components/player-picker.tsx): one
// slot of the new-challenge form, and a searchable list over the opponents the
// website said may be challenged. The Elo trails only when the member shows it.

func eloText(_ elo: Double?) -> String? { elo.map { String(roundHalfUp($0)) } }

/// Name or handle, case aside, as the web filters.
func matchesSearch(_ o: Opponent, _ query: String) -> Bool {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if q.isEmpty { return true }
    return o.fullName.lowercased().contains(q) || (o.handle?.lowercased().contains(q) ?? false)
}

struct PlayerSlot: View {
    let label: String
    let selected: Opponent?
    let trailing: String?
    let placeholder: String
    let onClick: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: label)
            Button(action: onClick) {
                HStack(spacing: 10) {
                    if let selected {
                        Avatar(name: selected.fullName, seed: selected.id, size: .sm)
                        Text(selected.fullName)
                            .foregroundStyle(Palette.text)
                            .textStyle(TypeStyle.rowTitle)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let trailing {
                            Text(trailing).foregroundStyle(Palette.muted).textStyle(TextSpec(face: .mono(weight: 400), size: 12, relativeTo: .caption))
                        }
                    } else {
                        Text(placeholder)
                            .foregroundStyle(Palette.placeholder)
                            .textStyle(TypeStyle.body(14))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(minHeight: 48)
                .contentShape(Rectangle())
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.line, lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
    }
}

/// The picker as a sheet: a search field over the list, Clear when the slot is filled.
struct PlayerPickerSheet: View {
    let title: String
    let players: [Opponent]
    let trailing: (Opponent) -> String?
    let allowClear: Bool
    let onPick: (Opponent?) -> Void
    let onDismiss: () -> Void
    @State private var query = ""

    var body: some View {
        let shown = players.filter { matchesSearch($0, query) }
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title).foregroundStyle(Palette.text).textStyle(TypeStyle.cardTitle)
                Spacer()
                if allowClear {
                    SheetButton(title: "Clear", color: Palette.ink2) { onPick(nil) }
                }
                SheetButton(title: "Close", color: Palette.ink2, action: onDismiss)
            }
            .padding(.bottom, 12)
            TextField("", text: $query, prompt: Text("Search by name or handle").foregroundStyle(Palette.placeholder))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(Palette.text)
                .textStyle(TypeStyle.body(14))
                .fieldBox(focused: false)
            if shown.isEmpty {
                Text("No players match.").foregroundStyle(Palette.muted).textStyle(TypeStyle.body(13)).padding(.top, 14)
            }
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(shown, id: \.id) { o in
                        Button { onPick(o) } label: {
                            HStack(spacing: 10) {
                                Avatar(name: o.fullName, seed: o.id, size: .sm)
                                VStack(alignment: .leading, spacing: 0) {
                                    Text(o.fullName).foregroundStyle(Palette.text).textStyle(TypeStyle.rowTitle).lineLimit(1)
                                    if let handle = o.handle, !handle.isEmpty {
                                        Text("@\(handle)").foregroundStyle(Palette.muted).textStyle(TypeStyle.rowSub).lineLimit(1)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                if let t = trailing(o) {
                                    Text(t).foregroundStyle(Palette.muted).textStyle(TextSpec(face: .mono(weight: 400), size: 12, relativeTo: .caption))
                                }
                            }
                            .padding(.vertical, 6)
                            .frame(minHeight: 52)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.top, 8)
        }
        .padding(20)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Palette.surface.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// A dialog's text button: the web's plain coloured link, 48 points tall.
struct SheetButton: View {
    let title: String
    let color: Color
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .foregroundStyle(enabled ? color : color.opacity(0.55))
                .textStyle(TypeStyle.body(14, weight: 600))
                .padding(.horizontal, 12)
                .frame(minHeight: 48)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}
