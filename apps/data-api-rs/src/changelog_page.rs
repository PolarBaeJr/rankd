// The public changelog served at /changelog, compiled into the binary.
//
// docs/changelog.html is GENERATED from apps/data-api/src/changelog-page.ts by
// scripts/pages.mjs, as docs/documentations.html is from docs-page.ts, so the
// two services serve the same bytes; `npm run parity -w data-api-rs` fails
// when either file is stale. It shares the documentation page's one
// stylesheet, so DOCS_CSP covers it too.

pub const CHANGELOG_HTML: &str = include_str!("docs/changelog.html");
