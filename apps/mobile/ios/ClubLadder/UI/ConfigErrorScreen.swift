import SwiftUI

/// Shown instead of the app when the build has no Supabase address or key.
struct ConfigErrorScreen: View {
    let missing: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BrandTile(size: 56, corner: 12, markSize: 28)
            Text("This build is not configured")
                .foregroundStyle(Palette.text)
                .textStyle(TextSpec(face: .condensed, size: 26, relativeTo: .title2))
                .padding(.top, 20)
                .padding(.bottom, 12)
            Text(
                "Missing or invalid: \(missing.joined(separator: ", ")). Copy Config/Local.xcconfig.example to " +
                    "Config/Local.xcconfig, fill in the Supabase host and the anon key, and rebuild.",
            )
            .foregroundStyle(Palette.muted)
            .textStyle(TypeStyle.body(15, lineHeight: 21))
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Palette.background)
    }
}
