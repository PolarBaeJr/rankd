// A copy of packages/shared/src/utils/data-api-key.ts, which is what the
// console mints with. This crate cannot import that file, so
// tests/key.rs checks the two agree against vectors that
// packages/shared/src/utils/__tests__/data-api-key.test.ts pins on the minting
// side: a change to either fails a test.

use sha2::{Digest, Sha256};

pub const KEY_PREFIX: &str = "clubld_";
const KEY_BODY_LEN: usize = 43;

/// `/^clubld_[A-Za-z0-9_-]{43}$/`.
pub fn is_key(s: &str) -> bool {
    match s.strip_prefix(KEY_PREFIX) {
        Some(body) => {
            body.len() == KEY_BODY_LEN
                && body
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }
        None => false,
    }
}

/// sha256 hex of the full plaintext key, prefix included.
pub fn hash_key(key: &str) -> String {
    hex(&Sha256::digest(key.as_bytes()))
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}
