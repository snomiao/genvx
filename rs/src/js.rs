//! The few JavaScript string rules the TypeScript relies on, spelled out.

/// What `String.prototype.trim` removes: ECMAScript WhiteSpace and
/// LineTerminator. Not the same set as `char::is_whitespace` (JavaScript
/// trims U+FEFF and does not trim U+0085).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `s.trim()`
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// What `.` does not match in a regular expression without the `s` flag.
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `buffer.toString("utf8")`: invalid sequences become U+FFFD, one per
/// maximal invalid subpart, and a leading BOM is kept.
pub fn utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `parseInt(s, 10)` for the values that matter here: `None` is NaN, and a
/// number too large for i64 is reported as `i64::MAX` (callers only compare
/// against small bounds).
pub fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start_matches(is_space);
    let (negative, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let end = digits.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let value = digits[..end].parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_follows_javascript_not_unicode() {
        assert_eq!(trim("\u{feff} \t\r\n a b \u{a0}\u{3000}\u{2028}"), "a b");
        // U+0085 is White_Space in Unicode but not in ECMAScript.
        assert_eq!(trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
        assert_eq!(trim(""), "");
    }

    /// Bytes and the string bun 1.4.0 decodes them to (recorded with
    /// `readFile(path, "utf-8")`, re-encoded and printed as hex).
    #[test]
    fn utf8_replaces_invalid_bytes_the_way_bun_does() {
        let bytes: &[u8] = &[
            0x41, 0xff, 0x42, 0xc3, 0x28, 0xe2, 0x82, 0x43, 0xf0, 0x9f, 0x92, 0x44, 0xed, 0xa0, 0x80, 0x45, 0xf8,
            0x88, 0x80, 0x80, 0x80, 0x46, 0xc0, 0xaf, 0x47, 0xe0, 0x80, 0xaf, 0x48, 0xf4, 0x90, 0x80, 0x80, 0x49,
            0xe2, 0x82,
        ];
        let expected = "41efbfbd42efbfbd28efbfbd43efbfbd44efbfbdefbfbdefbfbd45efbfbdefbfbdefbfbdefbfbdefbfbd46efbfbdefbfbd47efbfbdefbfbdefbfbd48efbfbdefbfbdefbfbdefbfbd49efbfbd";
        let hex: String = utf8(bytes).bytes().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, expected);
        // A BOM stays.
        assert_eq!(utf8(&[0xef, 0xbb, 0xbf, 0x41]), "\u{feff}A");
    }

    /// Inputs and results of `parseInt(s, 10)` recorded from bun 1.4.0.
    #[test]
    fn parse_int_follows_javascript() {
        let cases: &[(&str, Option<i64>)] = &[
            (" 17", Some(17)),
            ("17abc", Some(17)),
            ("1e1", Some(1)),
            ("0x10", Some(0)),
            ("-1", Some(-1)),
            ("", None),
            ("+5", Some(5)),
            ("\n9", Some(9)),
            ("017", Some(17)),
            ("１７", None),
            ("1_0", Some(1)),
            ("\u{a0}5", Some(5)),
            ("\u{feff}6", Some(6)),
            ("x", None),
            ("-", None),
        ];
        for (input, expected) in cases {
            assert_eq!(parse_int(input), *expected, "parseInt({input:?})");
        }
        assert_eq!(parse_int("99999999999999999999999"), Some(i64::MAX));
    }
}
