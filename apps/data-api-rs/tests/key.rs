// The key format and digest agree with the console's minting helper,
// packages/shared/src/utils/data-api-key.ts. This crate cannot import that
// file, so it reads it off disk. The TypeScript service's key test pins the
// same fixed vector against the helper itself, so a change on either side
// fails a test.

mod common;

use data_api_rs::key::{KEY_PREFIX, hash_key, is_key};

fn shared() -> String {
    common::read_repo_file("packages/shared/src/utils/data-api-key.ts")
}

/// The text between `marker` and the next `end`.
fn between<'a>(s: &'a str, marker: &str, end: &str) -> &'a str {
    let start = s
        .find(marker)
        .unwrap_or_else(|| panic!("{marker} not found"))
        + marker.len();
    let len = s[start..].find(end).expect("end marker");
    &s[start..start + len]
}

#[test]
fn uses_the_same_prefix_and_pattern_as_the_console() {
    let src = shared();
    assert_eq!(between(&src, "DATA_API_KEY_PREFIX = '", "'"), KEY_PREFIX);
    // is_key implements exactly this pattern; its doc comment names it.
    assert_eq!(
        between(&src, "DATA_API_KEY_PATTERN = /", "/;"),
        "^clubld_[A-Za-z0-9_-]{43}$"
    );
}

#[test]
fn accepts_freshly_minted_keys() {
    for _ in 0..50 {
        let key = common::new_key();
        assert!(is_key(&key), "{key}");
    }
}

#[test]
fn refuses_anything_the_pattern_refuses() {
    let body = "A".repeat(43);
    assert!(is_key(&format!("clubld_{body}")));
    for bad in [
        format!("clubld_{}", "A".repeat(42)),
        format!("clubld_{}", "A".repeat(44)),
        format!("clubld_{}+", "A".repeat(42)),
        format!("clubld_{}=", "A".repeat(42)),
        format!("clubld_{}/", "A".repeat(42)),
        format!("{}{body}", KEY_PREFIX.to_ascii_uppercase()),
        format!(" clubld_{body}"),
        format!("clubld_{body}\n"),
        format!("clubld_{}\u{e9}", "A".repeat(42)),
        body.clone(),
        String::new(),
    ] {
        assert!(!is_key(&bad), "{bad:?}");
    }
}

#[test]
fn matches_a_fixed_vector_sha256_hex_of_the_whole_plaintext_prefix_included() {
    let key = format!("clubld_{}", "A".repeat(43));
    // Computed independently: printf 'clubld_AAA...' | shasum -a 256
    assert_eq!(
        hash_key(&key),
        "8749244bc84d815963722d3d380ab0f42d5f2988325d271524161515d01fb463"
    );
    assert_eq!(
        hash_key(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}
