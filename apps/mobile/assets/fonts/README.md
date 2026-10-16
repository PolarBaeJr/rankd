# fonts

Both apps set the website's three faces. The TTFs live in
`android/app/src/main/res/font` (Android reads fonts only from there); the iOS
app bundles the same five files straight from that directory (`ios/project.yml`,
listed under `UIAppFonts` in `Info.plist`), so there is one copy. This directory
keeps their licences and how they were made. Both typefaces are under
the SIL Open Font License 1.1 with no Reserved Font Name, so subsetting and
converting them is allowed. `OFL-Barlow.txt` and `OFL-JetBrainsMono.txt` are
copied verbatim from `apps/player/src/fonts`, and the app also ships them, with
the Lucide icon licence, in `android/app/src/main/assets/licenses`.

| File | Made from | Size |
|---|---|---|
| `barlow_regular.ttf` | `barlow-latin-400.woff2` | 33,748 bytes |
| `barlow_semibold.ttf` | `barlow-latin-600.woff2` | 35,284 bytes |
| `barlow_bold.ttf` | `barlow-latin-700.woff2` | 35,104 bytes |
| `barlow_condensed_bold.ttf` | `barlow-condensed-latin-700.woff2` | 33,924 bytes |
| `jetbrains_mono.ttf` | `jetbrains-mono-latin-400.woff2` | 73,508 bytes |

Latin only, like the website's JetBrains Mono. Any other character (an accented
or Vietnamese name, say) falls back to the phone's own font, glyph by glyph.
Barlow 500 is not shipped: a request for it lands on 400. Barlow Condensed ships
700 only, which is every weight the app asks of it.

JetBrains Mono is a variable font (one `wght` axis, 400 to 800, default 400).
The one file serves 400, 500, 600 and 700 through `FontVariation` in
`ui/theme/Type.kt`. Two static instances (400 and 700, made with
`fonttools varLib.instancer`) came to about 52 KB compressed against about 37 KB
for the variable file, so the variable file won.

To rebuild, from `apps/player/src/fonts`, with a Python virtual environment that
has `fonttools` and `brotli` installed:

```sh
pyftsubset barlow-latin-400.woff2 --unicodes='*' --layout-features='*' \
  --no-hinting --output-file=barlow_regular.ttf
```

and the same for each row of the table. Without `--flavor` the output is a plain
TTF, which is what Android wants.
