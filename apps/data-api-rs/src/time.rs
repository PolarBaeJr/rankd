// Date.parse and Date.prototype.toISOString, for the forms this service meets.
//
// Date.parse is the ECMAScript date-time string format as V8 reads it: a date
// of YYYY, YYYY-MM or YYYY-MM-DD (or a six-digit signed year), optionally
// followed by T, HH:mm, optional :ss and a fraction of any length (truncated
// to milliseconds), then Z or an offset. A date alone is UTC; a date-time with
// no zone is local time, which is UTC in the image. V8 also accepts a day past
// the end of its month (2026-02-30 is 2 March), hour 24 only as 24:00:00.000,
// a lowercase t or z, and an offset written +HHMM.
//
// V8 then falls back to a legacy parser for anything else ("2026/09/14", an
// RFC 2822 date, "2026-9-14"). That fallback is NOT ported: such a string is
// NaN here. Query parameters are pattern-checked before they are parsed, and
// PostgREST prints ISO 8601, so neither reaches the fallback. The vectors in
// tests/vectors/dates.json mark each legacy-only input.

const MS_PER_DAY: i64 = 86_400_000;
/// The largest time value a Date holds, either side of the epoch.
const MAX_TIME: i64 = 8_640_000_000_000_000;

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    // Howard Hinnant's algorithm, proleptic Gregorian, March-based year.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn eat_any(&mut self, cs: &[u8]) -> Option<u8> {
        let c = self.peek()?;
        if cs.contains(&c) {
            self.i += 1;
            Some(c)
        } else {
            None
        }
    }

    fn digits(&mut self, n: usize) -> Option<i64> {
        let s = self.b.get(self.i..self.i + n)?;
        if !s.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.i += n;
        Some(s.iter().fold(0, |acc, d| acc * 10 + (d - b'0') as i64))
    }

    fn done(&self) -> bool {
        self.i == self.b.len()
    }
}

/// Date.parse: milliseconds since the epoch, or None where V8 gives NaN.
pub fn parse(s: &str) -> Option<i64> {
    let mut c = Cursor {
        b: s.as_bytes(),
        i: 0,
    };

    let year = match c.peek()? {
        b'+' | b'-' => {
            let neg = c.peek() == Some(b'-');
            c.i += 1;
            let y = c.digits(6)?;
            if neg && y == 0 {
                return None;
            }
            if neg { -y } else { y }
        }
        _ => c.digits(4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if c.eat(b'-') {
        month = c.digits(2)?;
        if c.eat(b'-') {
            day = c.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let (mut hour, mut minute, mut second, mut ms) = (0, 0, 0, 0);
    let mut offset_min: i64 = 0;
    if c.eat_any(b"Tt").is_some() {
        hour = c.digits(2)?;
        if !c.eat(b':') {
            return None;
        }
        minute = c.digits(2)?;
        if c.eat(b':') {
            second = c.digits(2)?;
            if c.eat(b'.') {
                let start = c.i;
                while c.peek().is_some_and(|d| d.is_ascii_digit()) {
                    c.i += 1;
                }
                let frac = &c.b[start..c.i];
                if frac.is_empty() {
                    return None;
                }
                let mut v = 0;
                for k in 0..3 {
                    v = v * 10 + frac.get(k).map_or(0, |d| (d - b'0') as i64);
                }
                ms = v;
            }
        }
        if hour > 24 || minute > 59 || second > 59 {
            return None;
        }
        if hour == 24 && (minute != 0 || second != 0 || ms != 0) {
            return None;
        }
        if c.eat_any(b"Zz").is_none()
            && let Some(sign) = c.eat_any(b"+-")
        {
            let h = c.digits(2)?;
            c.eat(b':');
            let m = c.digits(2)?;
            if h > 23 || m > 59 {
                return None;
            }
            offset_min = (h * 60 + m) * if sign == b'-' { -1 } else { 1 };
        }
    }
    if !c.done() {
        return None;
    }

    let days = days_from_civil(year, month, day);
    let t =
        days * MS_PER_DAY + ((hour * 60 + minute) * 60 + second) * 1000 + ms - offset_min * 60_000;
    if t.abs() > MAX_TIME { None } else { Some(t) }
}

/// Date.prototype.toISOString. None where it would throw a RangeError.
pub fn to_iso(t: i64) -> Option<String> {
    if t.abs() > MAX_TIME {
        return None;
    }
    let days = t.div_euclid(MS_PER_DAY);
    let rem = t.rem_euclid(MS_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    };
    Some(format!(
        "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    ))
}

/// isoSeconds for a string: second precision with Z, or None when Date.parse
/// cannot read it (the caller then passes the string through unchanged).
pub fn iso_seconds(s: &str) -> Option<String> {
    let iso = to_iso(parse(s)?)?;
    Some(strip_millis(&iso))
}

/// `.replace(/\.\d{3}Z$/, 'Z')`.
pub fn strip_millis(iso: &str) -> String {
    let b = iso.as_bytes();
    let n = b.len();
    if n >= 5
        && b[n - 1] == b'Z'
        && b[n - 5] == b'.'
        && b[n - 4..n - 1].iter().all(u8::is_ascii_digit)
    {
        format!("{}Z", &iso[..n - 5])
    } else {
        iso.to_string()
    }
}
