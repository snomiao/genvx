//! The encrypted file format of src/index.ts, bit for bit.
//!
//! v2 (written): `v2:{logN}:{salt}:{iv}:{tag}:{ciphertext}`, each part base64;
//!   key = scrypt(GENVX_KEY, salt, N = 2^logN, r = 8, p = 1), AES-256-GCM
//!   with a 16-byte IV.
//! v1 (read only): `{iv}:{tag}:{ciphertext}` in hex; key = scrypt(GENVX_KEY,
//!   project id, N = 16384, r = 8, p = 1).

use aes_gcm::aead::consts::{U12, U16};
use aes_gcm::aes::Aes256;
use aes_gcm::{AeadInOut, AesGcm, KeyInit};
use sha2::{Digest, Sha256};

use crate::js;

const SALT_LENGTH: usize = 32;
const IV_LENGTH: usize = 16;
const TAG_LENGTH: usize = 16;
/// N = 2^17 for what is written.
const SCRYPT_LOG_N: u8 = 17;
/// node's default N (16384), which v1 used.
const V1_LOG_N: u8 = 14;
/// With r = 8 and the TypeScript's `maxmem` of 256 MiB, bun accepts N from
/// 2^1 to 2^17 and throws for anything else.
const MAX_LOG_N: i64 = 17;

pub fn sha256_hex(data: &[u8]) -> String {
    hex_encode(&Sha256::digest(data))
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// `Buffer.from(text, "hex")`: whole pairs of hex digits up to the first
/// thing that is not one; the rest is ignored.
pub fn hex_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 2);
    let mut chars = text.chars();
    while let (Some(high), Some(low)) = (chars.next(), chars.next()) {
        match (high.to_digit(16), low.to_digit(16)) {
            (Some(high), Some(low)) => out.push((high * 16 + low) as u8),
            _ => break,
        }
    }
    out
}

/// `buffer.toString("base64")`
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// `Buffer.from(text, "base64")`: reads up to the first `=`, accepts the
/// standard and the URL-safe alphabet, skips everything else (so a newline
/// at the end of a store file does no harm), and drops a lone final character.
pub fn base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut count = 0;
    for c in text.chars() {
        let value = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        acc = acc << 6 | value;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(acc >> 16) as u8, (acc >> 8) as u8, acc as u8]);
            acc = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((acc >> 4) as u8),
        3 => out.extend_from_slice(&[(acc >> 10) as u8, (acc >> 2) as u8]),
        _ => {}
    }
    out
}

/// `randomBytes(n)`
pub fn random(n: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).expect("the operating system's random source failed");
    bytes
}

/// The master key (GENVX_KEY) and the keys derived from it so far. scrypt at
/// N = 2^17 takes most of a second, and one run derives the same key more
/// than once (to compare, to list, to write), so derived keys are kept.
pub struct Keys {
    master: String,
    derived: Vec<(Vec<u8>, u8, [u8; 32])>,
}

impl Keys {
    pub fn new(master: String) -> Keys {
        Keys { master, derived: Vec::new() }
    }

    fn derive(&mut self, salt: &[u8], log_n: u8) -> [u8; 32] {
        if let Some((_, _, key)) = self.derived.iter().find(|(s, n, _)| s == salt && *n == log_n) {
            return *key;
        }
        let params = scrypt::Params::new(log_n, 8, 1).expect("scrypt parameters");
        let mut key = [0u8; 32];
        scrypt::scrypt(self.master.as_bytes(), salt, &params, &mut key).expect("scrypt output length");
        self.derived.push((salt.to_vec(), log_n, key));
        key
    }
}

/// `encrypt(content, masterKey)`: always v2.
pub fn encrypt(content: &str, keys: &mut Keys) -> String {
    let salt = random(SALT_LENGTH);
    let key = keys.derive(&salt, SCRYPT_LOG_N);
    let iv = random(IV_LENGTH);
    let mut data = content.as_bytes().to_vec();
    let cipher = AesGcm::<Aes256, U16>::new_from_slice(&key).expect("key length");
    let nonce: [u8; IV_LENGTH] = iv.as_slice().try_into().expect("iv length");
    let tag = cipher
        .encrypt_inout_detached(&nonce.into(), b"", data.as_mut_slice().into())
        .expect("AES-GCM encryption");
    format!(
        "v2:{}:{}:{}:{}:{}",
        SCRYPT_LOG_N,
        base64_encode(&salt),
        base64_encode(&iv),
        base64_encode(&tag),
        base64_encode(&data)
    )
}

/// What cannot be decrypted, for whatever reason. The TypeScript reports
/// every failure the same way.
#[derive(Debug, PartialEq)]
pub struct Undecryptable;

/// `decrypt(encryptedContent, masterKey, projectId)`
pub fn decrypt(text: &str, keys: &mut Keys, project_id: &str) -> Result<String, Undecryptable> {
    if text.starts_with("v2:") {
        decrypt_v2(text, keys)
    } else {
        decrypt_v1(text, keys, project_id)
    }
}

fn decrypt_v2(text: &str, keys: &mut Keys) -> Result<String, Undecryptable> {
    let parts: Vec<&str> = text.split(':').collect();
    if parts.len() != 6 || parts[0] != "v2" {
        return Err(Undecryptable);
    }
    let log_n = js::parse_int(parts[1]).ok_or(Undecryptable)?;
    if !(1..=MAX_LOG_N).contains(&log_n) {
        return Err(Undecryptable);
    }
    let salt = base64_decode(parts[2]);
    let iv = base64_decode(parts[3]);
    let tag = base64_decode(parts[4]);
    let mut data = base64_decode(parts[5]);
    let key = keys.derive(&salt, log_n as u8);
    open(&key, &iv, &tag, &mut data)?;
    Ok(js::utf8(&data))
}

fn decrypt_v1(text: &str, keys: &mut Keys, project_id: &str) -> Result<String, Undecryptable> {
    let mut parts = text.split(':');
    let (Some(iv), Some(tag), Some(body)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(Undecryptable);
    };
    if iv.is_empty() || tag.is_empty() || body.is_empty() {
        return Err(Undecryptable);
    }
    let key = keys.derive(project_id.as_bytes(), V1_LOG_N);
    let mut data = hex_decode(body);
    open(&key, &hex_decode(iv), &hex_decode(tag), &mut data)?;
    Ok(js::utf8(&data))
}

/// AES-256-GCM decryption in place. bun insists on a 16-byte tag. It takes
/// an IV of any length from one byte up; genvx has only ever written 16, and
/// this takes 16 and the standard 12.
fn open(key: &[u8; 32], iv: &[u8], tag: &[u8], data: &mut [u8]) -> Result<(), Undecryptable> {
    let tag: [u8; TAG_LENGTH] = tag.try_into().map_err(|_| Undecryptable)?;
    let result = match iv.len() {
        16 => {
            let nonce: [u8; 16] = iv.try_into().expect("checked length");
            AesGcm::<Aes256, U16>::new_from_slice(key)
                .expect("key length")
                .decrypt_inout_detached(&nonce.into(), b"", data.into(), &tag.into())
        }
        12 => {
            let nonce: [u8; 12] = iv.try_into().expect("checked length");
            AesGcm::<Aes256, U12>::new_from_slice(key)
                .expect("key length")
                .decrypt_inout_detached(&nonce.into(), b"", data.into(), &tag.into())
        }
        _ => return Err(Undecryptable),
    };
    result.map_err(|_| Undecryptable)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = "github.com/acme/app";

    fn keys(master: &str) -> Keys {
        Keys::new(master.to_string())
    }

    /// Ciphertexts written by the TypeScript `encrypt` (bun 1.4.0), the same
    /// ones rs/parity.gen.mjs uses.
    #[test]
    fn reads_what_the_typescript_wrote() {
        let mut k = keys("test-key-1");
        let v2 = "v2:17:Ly8B/efWVs6osRF6K0vaKexFpHIEZn57TD1iKcuLZEY=:zCnVWAbKhaYiHPrhWx/e+Q==:NxIJF9H+c8c/1/NhNGTtHA==:mdzyox9o8qc7FQ==";
        assert_eq!(decrypt(v2, &mut k, PROJECT).unwrap(), "A=1\nB=two\n");
        let cost10 = "v2:10:wbPFJUoY/ji7cbdemk/M5vPTRmSXKdrui9n9dngzlzs=:42C/mKJI9X5EX4PGqw4Wqw==:EtrWy+GHC4D7Ze77vkKA0A==:RFXgrw5Ot/+mqQ==";
        assert_eq!(decrypt(cost10, &mut k, PROJECT).unwrap(), "A=1\nB=two\n");
        let v1 = "bc4b0f705acc788635888c31d6025392:cc4aabfc052762ea2bc238c1a8e7179a:3b7a19544bc98adf27dd";
        assert_eq!(decrypt(v1, &mut k, PROJECT).unwrap(), "A=1\nB=two\n");
        assert_eq!(decrypt(v1, &mut k, "github.com/acme/other"), Err(Undecryptable));
        let empty = "v2:17:yh8n2nxVb7ryVWXydDBh5N6h2fei1Trc5fcXvnbFhdg=:W3sNXUnTwAFxfG9KmkNCZg==:iTLPiMO6DkHSF2gsLgiH2Q==:";
        assert_eq!(decrypt(empty, &mut k, PROJECT).unwrap(), "");
        let unicode = "v2:17:feYKdjiahPftK4NNP4DUQLYUwF+8zkTdRjoZLnbSg/s=:+5zQPX1r1uqaTPc1RGpZlA==:MwKUYUpL4W0ZcrBjE8fvzg==:MjOu3UvYdr5qL//8f4e8YdR2cdVyC0RB1tpIjSZXZWM=";
        assert_eq!(decrypt(unicode, &mut k, PROJECT).unwrap(), "NAME=héllo→世界\nEMOJI=🚀\n");
        assert_eq!(decrypt(v2, &mut keys("other-key-2"), PROJECT), Err(Undecryptable));
    }

    #[test]
    fn rejects_what_bun_rejects() {
        let mut k = keys("test-key-1");
        let good = "v2:10:wbPFJUoY/ji7cbdemk/M5vPTRmSXKdrui9n9dngzlzs=:42C/mKJI9X5EX4PGqw4Wqw==:EtrWy+GHC4D7Ze77vkKA0A==:RFXgrw5Ot/+mqQ==";
        // A newline after the text is harmless, as is junk after the cost.
        assert!(decrypt(&format!("{good}\n"), &mut k, PROJECT).is_ok());
        assert!(decrypt(&good.replace("v2:10:", "v2: 10abc:"), &mut k, PROJECT).is_ok());
        for bad in [
            good.replace("v2:10:", "v2:0:"),
            good.replace("v2:10:", "v2:18:"),
            good.replace("v2:10:", "v2:-1:"),
            good.replace("v2:10:", "v2:x:"),
            good.replace("v2:10:", "v2::"),
            good.replace("RFXg", "RFXh"),
            good.replace("EtrW", "EtrX"),
            good.replace("EtrWy+GHC4D7Ze77vkKA0A==", "EtrWy+GHC4D7Ze77"),
            good.rsplit_once(':').unwrap().0.to_string(),
            format!(" {good}"),
            "A=1\n".to_string(),
            String::new(),
            "aa:bb:".to_string(),
            "aa::cc".to_string(),
        ] {
            assert_eq!(decrypt(&bad, &mut k, PROJECT), Err(Undecryptable), "{bad:?}");
        }
    }

    #[test]
    fn round_trip_has_the_format_the_typescript_writes() {
        let mut k = keys("round-trip");
        let text = encrypt("X=1\n", &mut k);
        let parts: Vec<&str> = text.split(':').collect();
        assert_eq!(parts.len(), 6);
        assert_eq!(&parts[..2], ["v2", "17"]);
        assert_eq!(base64_decode(parts[2]).len(), 32);
        assert_eq!(base64_decode(parts[3]).len(), 16);
        assert_eq!(base64_decode(parts[4]).len(), 16);
        for part in &parts[2..] {
            assert_eq!(base64_encode(&base64_decode(part)), *part);
        }
        assert_eq!(decrypt(&text, &mut k, PROJECT).unwrap(), "X=1\n");
        assert_ne!(encrypt("X=1\n", &mut k), text, "salt and IV are random");
    }

    /// `scryptSync` results recorded from bun 1.4.0 ("pw", "salt", 32 bytes,
    /// r = 8, p = 1).
    #[test]
    fn scrypt_matches_bun() {
        let derive = |password: &str, salt: &[u8], log_n: u8| hex_encode(&Keys::new(password.to_string()).derive(salt, log_n));
        assert!(derive("pw", b"salt", 1).starts_with("4cbdb60172092608"));
        assert!(derive("pw", b"salt", 2).starts_with("19398561c020444b"));
        assert!(derive("pw", b"salt", 5).starts_with("398da36effd513f2"));
        assert!(derive("pw", b"salt", 10).starts_with("9f1f8695838e682c"));
        assert_eq!(derive("pw", b"salt", 14), "c0b515908e61334cae6d6003c00be60e2e675878c9ac8ba282e1d70c335d3012");
        assert_eq!(derive("pw", b"", 4), "d2edcaceddb98a212607650d7fb42a5de91053904dc85e191a45f0b55e9770e5");
        assert_eq!(derive("", b"salt", 4), "bcda6cb6c38d6459c333688c498370f474cf36a046e49430d82c717893f716bf");
    }

    /// AES-256-GCM of "hello world" under a key of 32 bytes 0x07 and an IV
    /// of bytes 0x03, recorded from bun 1.4.0.
    #[test]
    fn gcm_matches_bun_for_both_iv_lengths() {
        let key = [7u8; 32];
        for (iv_len, body, tag) in [
            (12, "4d9bcf6f3508292d082c27", "cafb66dad0cdb83c97a3a17e0bdfcce3"),
            (16, "691a292c15be92f2957acc", "bed70aa6a686cec68dde6fedc2c8384c"),
        ] {
            let mut data = hex_decode(body);
            open(&key, &vec![3u8; iv_len], &hex_decode(tag), &mut data).unwrap();
            assert_eq!(data, b"hello world");
            // bun: "Invalid authentication tag length" for anything but 16.
            for cut in [0, 4, 8, 12, 15] {
                let mut data = hex_decode(body);
                assert_eq!(open(&key, &vec![3u8; iv_len], &hex_decode(tag)[..cut], &mut data), Err(Undecryptable));
            }
        }
        let mut data = hex_decode("90c5907d3ef03aa93c0819");
        assert_eq!(open(&key, &[], &hex_decode("a901726031780f36e129090e06efd920"), &mut data), Err(Undecryptable));
    }

    /// `Buffer.from(s, "base64").toString("hex")` recorded from bun 1.4.0.
    #[test]
    fn base64_is_as_lenient_as_bun() {
        let cases: &[(&str, &str)] = &[
            ("QUJD\n", "414243"),
            ("QUJD ", "414243"),
            (" QUJD", "414243"),
            ("QU JD", "414243"),
            ("QUJD=", "414243"),
            ("QUJD==", "414243"),
            ("QUJ", "4142"),
            ("QU", "41"),
            ("Q", ""),
            ("QUJDRA", "41424344"),
            ("QUJDRA=", "41424344"),
            ("QUJDRA==", "41424344"),
            ("QUJD-_", "414243fb"),
            ("QUJD+/", "414243fb"),
            ("QU=JD", "41"),
            ("QU==JD", "41"),
            ("QUJD!@#", "414243"),
            ("Q!UJD", "414243"),
            ("====", ""),
            ("", ""),
            ("QUJD\r\n", "414243"),
            ("QUJDRA=\n", "41424344"),
            ("QUJDRA==\n", "41424344"),
            ("QUJDRA==QUJD", "41424344"),
            ("QUJDR", "414243"),
            ("QUJDRA===", "41424344"),
            ("QUJDRA=x", "41424344"),
            ("QUJDRAx=", "414243440c"),
            ("Q=", ""),
            ("QQ=", "41"),
            ("QQ==", "41"),
            ("QQ=Q", "41"),
            ("\tQU\nJD\r", "414243"),
            ("QUJD\u{a0}", "414243"),
            ("QUJDé", "414243"),
            ("QUJDRA\n==", "41424344"),
            ("QUJDRA=\n=", "41424344"),
            ("QR==", "41"),
            ("QUL=", "4142"),
            ("QUJDRB==", "41424344"),
        ];
        for (input, expected) in cases {
            assert_eq!(hex_encode(&base64_decode(input)), *expected, "{input:?}");
        }
        for bytes in [&b""[..], b"A", b"AB", b"ABC", b"ABCD", &[0xfb, 0xff, 0x00]] {
            assert_eq!(base64_decode(&base64_encode(bytes)), bytes);
        }
        assert_eq!(base64_encode(&[0xfb, 0xff]), "+/8=");
    }

    /// `Buffer.from(s, "hex").toString("hex")` recorded from bun 1.4.0.
    #[test]
    fn hex_is_as_lenient_as_bun() {
        let cases: &[(&str, &str)] = &[
            ("abc", "ab"),
            ("abzz12", "ab"),
            ("AB12", "ab12"),
            (" ab", ""),
            ("ab\n", "ab"),
            ("0xab", ""),
            ("ab cd", "ab"),
            ("a", ""),
            ("", ""),
            ("abcd\n", "abcd"),
            ("zz", ""),
            ("ab-cd", "ab"),
            ("abcdé", "abcd"),
            ("aBcD", "abcd"),
        ];
        for (input, expected) in cases {
            assert_eq!(hex_encode(&hex_decode(input)), *expected, "{input:?}");
        }
    }

    #[test]
    fn branch_hash() {
        assert_eq!(&sha256_hex(b"github.com/acme/app")[..16], "98d9fc12e0202ede");
    }
}
