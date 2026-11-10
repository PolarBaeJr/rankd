# The public export

`main` is a generated, branding-free copy of this code, so another club can
clone it and run its own instance. Nobody edits `main` by hand:
[`../workflows/export-main.yml`](../workflows/export-main.yml) rebuilds it from
the production branch with `export.mjs`, and refuses to touch it if its tip is
anything but an earlier export commit.

## What the export does

1. **Selects files, default-deny.** Files are enumerated from git (never a
   directory walk), and a path ships only when the last
   [`include.txt`](include.txt) line matching it is a positive one. The `deny`
   list in [`leak-rules.json`](leak-rules.json) overrides `include.txt`. An
   include line that matches nothing fails the run, so the list cannot go stale.
   Symlinks and submodules fail.
2. **Replaces branding** with the literal rules in
   [`brand-map.json`](brand-map.json): case-sensitive, longest first, optionally
   scoped with `paths` or `exclude`. Every rule's hit count is printed, and a
   rule that matched nothing warns. A rule marked `"path": true` also renames
   the exported paths it matches, so the mobile app's Kotlin package
   directories and Xcode target folders move with the `package` lines and
   project files naming them; two sources landing on one path fail. From here
   on paths are the exported ones: leak-rule exceptions and `binaryAllow` name
   them, while `include.txt` and the brand map's own scopes name source paths.
3. **Redacts migration comments.** Migrations are immutable in source, so a
   whole-line `--` comment that still trips a failing leak rule becomes
   `-- (redacted in export)`. SQL, string literals and line count are untouched.
   A leak rule can be scoped with `paths` or `exclude` like a brand rule, so a
   word that only warns elsewhere (the hosts' names) has a failing twin scoped
   to `supabase/migrations/**` that gets such comments redacted.
   `supabase/migrations/.manifest.json` is then regenerated over the exported
   bytes, so the manifest test passes in the export.
4. **Cleans `.gitignore`**: comments go, as do negations naming nothing exported.
5. **Replaces the icons** with a generated neutral mark (`lib/icons.mjs`): the
   web apps' icons, and the native apps' Android launcher layers and iOS app
   icon. Each generated path must already be in the export, or the run fails.
6. **Checks links.** Every relative link in an exported markdown file must
   resolve to an exported path.
7. **Checks for leaks** in every file's contents and path:
   - `infra` and `secret`: deployment names and credential shapes;
   - `brand`: anything the brand map missed;
   - `email`: any address outside the reserved example domains;
   - `personal`: the literals in the `EXPORT_LEAK_PATTERNS` secret,
     case-insensitive and matched as whole words: a literal must meet a
     non-letter, a line end or a camelCase seam at each edge, so a name spelled
     across two words of an identifier (`LastEvent`) is not a hit;
   - `warn` rules report without failing.

   Exceptions in `leak-rules.json` name a path glob, a rule id and, ideally, a
   `match` regex for the one reviewed line, plus a reason.

A report line is `path:line: [category] rule <id>` and never carries the
matched text, because Actions logs on a public repo are public. A personal hit
names its position in the pattern list (`personal-3`), not the value.

## Dry run

CI dry-runs every push to every branch but `main` (export-main.yml), with the
personal patterns and `--verify`'s checks, so a leak or a test that needs a
private file fails on the commit that brought it. A failure there never holds
up a deploy; it only means the next publish would fail.

By hand, from the repo root, with Node 24, into any empty directory outside the repo:

```sh
node --test '.github/export/test/*.test.mjs'
node .github/export/export.mjs --out /tmp/club-export --worktree
```

- `--worktree` exports the working tree (tracked plus untracked, not ignored)
  instead of a committed ref. Without it, `--ref` (default `HEAD`) exports
  committed state only, which is what CI publishes.
- `--patterns-file <path>` reads the personal patterns from a file outside the
  repo instead of the environment. Without patterns a dry run warns that the
  personal check was skipped.
- `--require-patterns` makes missing or empty patterns a failure. Publishing
  always passes it.
- `--tree-hash` prints the git tree hash of the output.
- `--verify` runs `npm ci` and the turbo type-check, lint and test inside the
  output, leaving out apps/data-api-rs as ci.yml does (Rust, checked on arm64
  by data-api-rs.yml). It is slow; CI does it for you.

## Adding a file to the export

A new file is private until `include.txt` lists it. Add the narrowest glob that
covers it, dry-run, and fix any leak the report names: reword the source first,
add a brand-map rule only for real branding, and add an exception only for a
reviewed false positive, scoped to its line.

## Owner setup

- Set the personal patterns, one literal per line (member names, personal
  addresses, anything that must never reach `main`):

  ```sh
  gh secret set EXPORT_LEAK_PATTERNS < path/to/patterns.txt
  ```

  Keep that file outside the repo. Publishing fails until the secret is set.
- The workflow uses the default `GITHUB_TOKEN` with `contents: write` on the
  publish job only. If `main` is protected, allow `github-actions[bot]` to push
  to it, or the publish step fails.
- [`targets.json`](targets.json) names the branch the export publishes to.
