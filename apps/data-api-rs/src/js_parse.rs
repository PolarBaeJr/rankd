// JSON.parse for the request bodies of the writes.
//
// The TypeScript service reads a body with Buffer#toString('utf8') and
// JSON.parse. So invalid UTF-8 becomes U+FFFD, and a byte-order mark is NOT
// dropped: a body that starts with one is a syntax error, as it is in Node.
//
// serde_json refuses two things JSON.parse accepts, so this is its own parser.
// It is iterative, so deep nesting (which JSON.parse also takes) cannot run
// out of stack:
//
// - A number too large for a double. JSON.parse makes it an infinity; here it
//   becomes the largest finite double of the same sign, because a
//   serde_json::Number cannot hold an infinity. Nothing reads the difference:
//   the one numeric field (`probability`) refuses both, and every other field
//   refuses any number.
// - A lone UTF-16 surrogate in a `\u` escape. JSON.parse keeps it; a Rust
//   string cannot hold one, so it becomes U+FFFD. README lists this.

use serde_json::{Map, Value};

use crate::json::js_key_order_of;

/// JSON.parse of a body's bytes, or None where it throws a SyntaxError.
pub fn parse_body(bytes: &[u8]) -> Option<Value> {
    parse(&String::from_utf8_lossy(bytes))
}

/// Containers nested deeper than this are checked as JSON but kept empty. A
/// serde_json::Value drops (and compares, and prints) recursively, so a 64 KiB
/// body of `[[[[...` kept whole would overflow the stack on drop. No shape check
/// looks deeper than a few levels, and an emptied container keeps its kind, so
/// every answer is the one the whole value would get.
const MAX_KEPT_DEPTH: usize = 64;

enum Frame {
    Arr(Vec<Value>),
    /// The object so far and the key whose value is being parsed.
    Obj(Map<String, Value>, String),
    /// A container below MAX_KEPT_DEPTH: true for an array.
    Discard(bool),
}

struct Parser<'a> {
    text: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &str) -> Option<()> {
        if self.text[self.at..].starts_with(word) {
            self.at += word.len();
            Some(())
        } else {
            None
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = self.text.get(self.at..self.at + 4)?;
        if !digits.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        self.at += 4;
        u32::from_str_radix(digits, 16).ok()
    }

    /// A string, from its opening quote.
    fn string(&mut self) -> Option<String> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(c) = self.peek() {
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.at += 1;
            }
            out.push_str(&self.text[start..self.at]);
            match self.peek()? {
                b'"' => {
                    self.at += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.at += 1;
                    let escape = self.peek()?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            if (0xD800..0xDC00).contains(&unit) {
                                // A high surrogate pairs only with an escaped
                                // low one straight after it.
                                let before_low = self.at;
                                if self.text[self.at..].starts_with("\\u") {
                                    self.at += 2;
                                    if let Some(low) = self.hex4()
                                        && (0xDC00..0xE000).contains(&low)
                                    {
                                        let code =
                                            0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
                                        out.push(char::from_u32(code)?);
                                        continue;
                                    }
                                }
                                self.at = before_low;
                                out.push('\u{fffd}');
                            } else {
                                out.push(char::from_u32(unit).unwrap_or('\u{fffd}'));
                            }
                        }
                        _ => return None,
                    }
                }
                // A raw control character.
                _ => return None,
            }
        }
    }

    fn digits(&mut self) -> bool {
        let from = self.at;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.at += 1;
        }
        self.at > from
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek()? {
            b'0' => self.at += 1,
            b'1'..=b'9' => {
                self.digits();
            }
            _ => return None,
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if !self.digits() {
                return None;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if !self.digits() {
                return None;
            }
        }
        // Rust's parse rounds correctly, as JavaScript's does.
        let n: f64 = self.text[start..self.at].parse().ok()?;
        let n = if n.is_infinite() {
            f64::MAX.copysign(n)
        } else {
            n
        };
        serde_json::Number::from_f64(n).map(Value::Number)
    }

    /// An object key and its colon, from the key's opening quote.
    fn key(&mut self) -> Option<String> {
        if self.peek()? != b'"' {
            return None;
        }
        let key = self.string()?;
        self.skip_space();
        if self.peek()? != b':' {
            return None;
        }
        self.at += 1;
        Some(key)
    }
}

/// JSON.parse over text: the grammar of ECMA-404, whitespace of space, tab, CR
/// and LF only, and a repeated key keeping its first position and its last
/// value (serde_json's preserve_order map does exactly that on insert).
pub fn parse(text: &str) -> Option<Value> {
    let mut p = Parser { text, at: 0 };
    let mut stack: Vec<Frame> = Vec::new();
    loop {
        // One value, or the opening of a container.
        p.skip_space();
        let mut value = match p.peek()? {
            b'{' => {
                p.at += 1;
                p.skip_space();
                if p.peek() == Some(b'}') {
                    p.at += 1;
                    Value::Object(Map::new())
                } else {
                    let key = p.key()?;
                    stack.push(if stack.len() >= MAX_KEPT_DEPTH {
                        Frame::Discard(false)
                    } else {
                        Frame::Obj(Map::new(), key)
                    });
                    continue;
                }
            }
            b'[' => {
                p.at += 1;
                p.skip_space();
                if p.peek() == Some(b']') {
                    p.at += 1;
                    Value::Array(Vec::new())
                } else {
                    stack.push(if stack.len() >= MAX_KEPT_DEPTH {
                        Frame::Discard(true)
                    } else {
                        Frame::Arr(Vec::new())
                    });
                    continue;
                }
            }
            b'"' => Value::String(p.string()?),
            b't' => {
                p.literal("true")?;
                Value::Bool(true)
            }
            b'f' => {
                p.literal("false")?;
                Value::Bool(false)
            }
            b'n' => {
                p.literal("null")?;
                Value::Null
            }
            _ => p.number()?,
        };
        // Hand the value to the containers it completes.
        loop {
            p.skip_space();
            match stack.pop() {
                None => return (p.at == text.len()).then_some(value),
                Some(Frame::Arr(mut items)) => {
                    items.push(value);
                    match p.peek()? {
                        b',' => {
                            p.at += 1;
                            stack.push(Frame::Arr(items));
                            break;
                        }
                        b']' => {
                            p.at += 1;
                            value = Value::Array(items);
                        }
                        _ => return None,
                    }
                }
                Some(Frame::Obj(mut fields, key)) => {
                    fields.insert(key, value);
                    match p.peek()? {
                        b',' => {
                            p.at += 1;
                            p.skip_space();
                            let next = p.key()?;
                            stack.push(Frame::Obj(fields, next));
                            break;
                        }
                        b'}' => {
                            p.at += 1;
                            value = Value::Object(fields);
                        }
                        _ => return None,
                    }
                }
                Some(Frame::Discard(is_array)) => {
                    drop(value);
                    match (p.peek()?, is_array) {
                        (b',', _) => {
                            p.at += 1;
                            if !is_array {
                                p.skip_space();
                                p.key()?;
                            }
                            stack.push(Frame::Discard(is_array));
                            break;
                        }
                        (b']', true) => {
                            p.at += 1;
                            value = Value::Array(Vec::new());
                        }
                        (b'}', false) => {
                            p.at += 1;
                            value = Value::Object(Map::new());
                        }
                        _ => return None,
                    }
                }
            }
        }
    }
}

/// `Object.keys(object)`: array-index keys first, ascending, then the rest in
/// insertion order.
pub fn keys(object: &Map<String, Value>) -> Vec<&str> {
    js_key_order_of(object.keys().map(String::as_str))
}

/// `value.length` of a JavaScript string: UTF-16 code units.
pub fn length(s: &str) -> usize {
    s.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_what_json_parse_reads() {
        assert_eq!(
            parse(r#" {"a":[1,2.5,-0,true,null],"b":"x"} "#),
            Some(json!({"a":[1.0,2.5,-0.0,true,null],"b":"x"}))
        );
        assert_eq!(
            parse(r#"{"a":1,"b":2,"a":3}"#)
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(parse(r#"{"a":1,"a":3}"#), Some(json!({"a":3.0})));
        assert_eq!(
            parse(r#""\ud83d\ude00\u00e9\/""#),
            Some(json!("\u{1F600}\u{e9}/"))
        );
        assert_eq!(parse(r#""\ud800x""#), Some(json!("\u{fffd}x")));
        assert_eq!(parse("1e400"), Some(json!(f64::MAX)));
        assert_eq!(parse("-1e400"), Some(json!(-f64::MAX)));
        let deep = format!("{}{}", "[".repeat(40_000), "]".repeat(40_000));
        assert!(parse(&deep).is_some());
        let deep_objects = format!("{}1{}", "{\"a\":".repeat(40_000), "}".repeat(40_000));
        assert!(parse(&deep_objects).is_some());
        assert_eq!(
            parse(&format!("{}{}", "[".repeat(40_000), "]".repeat(39_999))),
            None
        );
        assert_eq!(
            parse(&format!("{}1,{}", "{\"a\":".repeat(100), "}".repeat(100))),
            None
        );
    }

    #[test]
    fn keeps_the_kind_of_a_container_it_empties() {
        let text = format!(
            "{}{{\"x\":[1]}}{}",
            "[".repeat(MAX_KEPT_DEPTH),
            "]".repeat(MAX_KEPT_DEPTH)
        );
        let mut value = &parse(&text).unwrap();
        for _ in 0..MAX_KEPT_DEPTH {
            value = &value.as_array().unwrap()[0];
        }
        assert_eq!(value, &json!({}));
    }

    #[test]
    fn throws_where_json_parse_throws() {
        for bad in [
            "",
            " ",
            "\u{feff}{}",
            "{",
            "[1,]",
            "{\"a\":1,}",
            "01",
            "1.",
            ".5",
            "+1",
            "1e",
            "'a'",
            "\"\t\"",
            "\"\\x\"",
            "\"\\u12\"",
            "tru",
            "nul",
            "{} x",
            "[1 2]",
            "{\"a\" 1}",
            "{a:1}",
            "NaN",
            "Infinity",
            "\u{a0}1",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn decodes_invalid_utf8_to_the_replacement_character() {
        assert_eq!(parse_body(b"\"a\xffb\""), Some(json!("a\u{fffd}b")));
    }

    #[test]
    fn orders_keys_as_object_keys_does() {
        let v = parse(r#"{"b":1,"2":1,"a":1,"1":1,"01":1}"#).unwrap();
        assert_eq!(keys(v.as_object().unwrap()), ["1", "2", "b", "a", "01"]);
        assert_eq!(length("a\u{1F600}"), 3);
    }
}
