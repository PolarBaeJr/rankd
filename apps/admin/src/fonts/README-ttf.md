# Why there are .ttf files in here as well as .woff2

The `.woff2` files are what the browser gets, through `next/font/local`.

The three `.ttf` files are for the social post slides
(`src/app/api/social-posts/[setId]/[slide]`), which `next/og` renders
server-side. **satori, which next/og renders through, cannot read WOFF2 at
all**, so the slides need the same faces in a format it can parse.

They are byte-for-byte copies of the player app's (`apps/player/src/fonts`),
which made them for its Discord profile card: each is that weight's latin,
latin-ext and vietnamese `.woff2` subsets merged into a single face, so an
accented name renders as itself instead of as a tofu box. The player app's
README there says how to regenerate them; copy the new files here as well.

| File | Merged from |
|---|---|
| `BarlowCondensed-Bold.ttf` | `barlow-condensed-{latin,latin-ext,vietnamese}-700.woff2` |
| `Barlow-Regular.ttf` | `barlow-{latin,latin-ext,vietnamese}-400.woff2` |
| `Barlow-SemiBold.ttf` | `barlow-{latin,latin-ext,vietnamese}-600.woff2` |

Same OFL licence as the source files: `OFL-Barlow.txt` covers these too.

**They reach the container through `outputFileTracingIncludes` in
`next.config.js`.** Nothing imports them (the route reads them off disk), so
without that entry the route builds clean and fails on its first real request.
`src/lib/social-posts/__tests__/slide-render.test.ts` asserts the tracing
entry and that these files really are TrueType.
