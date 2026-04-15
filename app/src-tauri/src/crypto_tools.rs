use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;

// ─── JWT ─────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct JwtDecoded {
    pub header: String,
    pub payload: String,
    pub signature_valid: Option<bool>,
    pub error: Option<String>,
}

pub fn jwt_decode(token: &str, secret: Option<&str>, algorithm: Option<&str>) -> JwtDecoded {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return JwtDecoded {
            header: String::new(),
            payload: String::new(),
            signature_valid: None,
            error: Some("Invalid JWT: expected 3 parts".into()),
        };
    }

    let decode_part = |part: &str| -> Result<String, String> {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(part)
            .map_err(|e| format!("Base64 decode: {e}"))?;
        let raw = String::from_utf8_lossy(&bytes).to_string();
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) => Ok(serde_json::to_string_pretty(&v).unwrap_or(raw)),
            Err(_) => Ok(raw),
        }
    };

    let header = decode_part(parts[0]).unwrap_or_default();
    let payload = decode_part(parts[1]).unwrap_or_default();

    let signature_valid = secret.and_then(|s| {
        if s.is_empty() {
            return None;
        }
        let alg = algorithm.unwrap_or("HS256");
        let validation_alg = match alg {
            "HS256" => jsonwebtoken::Algorithm::HS256,
            "HS384" => jsonwebtoken::Algorithm::HS384,
            "HS512" => jsonwebtoken::Algorithm::HS512,
            _ => return Some(false),
        };
        let key = jsonwebtoken::DecodingKey::from_secret(s.as_bytes());
        let mut validation = jsonwebtoken::Validation::new(validation_alg);
        validation.validate_exp = false;
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        match jsonwebtoken::decode::<serde_json::Value>(token, &key, &validation) {
            Ok(_) => Some(true),
            Err(_) => Some(false),
        }
    });

    JwtDecoded {
        header,
        payload,
        signature_valid,
        error: None,
    }
}

// ─── UUID / CUID2 ────────────────────────────────────────────────────────────

pub fn generate_uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn generate_uuid_v7() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn generate_cuid2() -> String {
    cuid2::create_id()
}

// ─── Hash ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct HashResult {
    pub hash: String,
    pub algorithm: String,
}

pub fn hash_text(input: &str, algorithm: &str) -> Result<HashResult, String> {
    use sha2::Digest;

    let hash = match algorithm {
        "md5" => {
            let mut h = md5::Md5::new();
            h.update(input.as_bytes());
            hex::encode(h.finalize())
        }
        "sha256" => {
            let mut h = sha2::Sha256::new();
            h.update(input.as_bytes());
            hex::encode(h.finalize())
        }
        "sha384" => {
            let mut h = sha2::Sha384::new();
            h.update(input.as_bytes());
            hex::encode(h.finalize())
        }
        "sha512" => {
            let mut h = sha2::Sha512::new();
            h.update(input.as_bytes());
            hex::encode(h.finalize())
        }
        _ => return Err(format!("Unsupported algorithm: {algorithm}")),
    };

    Ok(HashResult {
        hash,
        algorithm: algorithm.to_string(),
    })
}

pub fn hmac_sign(input: &str, key: &str, algorithm: &str) -> Result<HashResult, String> {
    use hmac::{Hmac, Mac};

    let hash = match algorithm {
        "hmac-sha256" => {
            let mut mac = Hmac::<sha2::Sha256>::new_from_slice(key.as_bytes())
                .map_err(|e| e.to_string())?;
            mac.update(input.as_bytes());
            hex::encode(mac.finalize().into_bytes())
        }
        "hmac-sha512" => {
            let mut mac = Hmac::<sha2::Sha512>::new_from_slice(key.as_bytes())
                .map_err(|e| e.to_string())?;
            mac.update(input.as_bytes());
            hex::encode(mac.finalize().into_bytes())
        }
        _ => return Err(format!("Unsupported HMAC algorithm: {algorithm}")),
    };

    Ok(HashResult {
        hash,
        algorithm: algorithm.to_string(),
    })
}

// ─── Bcrypt / Argon2 ─────────────────────────────────────────────────────────

pub fn bcrypt_hash(input: &str, cost: u32) -> Result<String, String> {
    bcrypt::hash(input, cost).map_err(|e| e.to_string())
}

pub fn bcrypt_verify(input: &str, hash: &str) -> Result<bool, String> {
    bcrypt::verify(input, hash).map_err(|e| e.to_string())
}

pub fn argon2_hash(input: &str) -> Result<String, String> {
    use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
    let salt = SaltString::generate(&mut rand::rngs::OsRng);
    Argon2::default()
        .hash_password(input.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn argon2_verify(input: &str, hash: &str) -> Result<bool, String> {
    use argon2::{password_hash::PasswordHash, Argon2, PasswordVerifier};
    let parsed = PasswordHash::new(hash).map_err(|e| e.to_string())?;
    Ok(Argon2::default().verify_password(input.as_bytes(), &parsed).is_ok())
}

// ─── Base64 encode / decode ──────────────────────────────────────────────────

pub fn base64_encode(input: &str) -> String {
    B64.encode(input.as_bytes())
}

pub fn base64_decode(input: &str) -> Result<String, String> {
    let bytes = B64.decode(input).map_err(|e| format!("Base64 decode: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("UTF-8 decode: {e}"))
}

// ─── URL encode / decode ─────────────────────────────────────────────────────

pub fn url_encode(input: &str) -> String {
    urlencoding_encode(input)
}

pub fn url_decode(input: &str) -> Result<String, String> {
    urlencoding_decode(input)
}

fn urlencoding_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push(char::from_digit((byte >> 4) as u32, 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit((byte & 0xf) as u32, 16).unwrap().to_ascii_uppercase());
            }
        }
    }
    out
}

fn urlencoding_decode(input: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next().ok_or("Incomplete percent encoding")?;
            let lo = chars.next().ok_or("Incomplete percent encoding")?;
            let val = u8::from_str_radix(
                &format!("{}{}", hi as char, lo as char),
                16,
            )
            .map_err(|e| format!("Invalid percent encoding: {e}"))?;
            bytes.push(val);
        } else if b == b'+' {
            bytes.push(b' ');
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).map_err(|e| format!("UTF-8 decode: {e}"))
}

// ─── Hex encode / decode ─────────────────────────────────────────────────────

pub fn hex_encode(input: &str) -> String {
    hex::encode(input.as_bytes())
}

pub fn hex_decode(input: &str) -> Result<String, String> {
    let bytes = hex::decode(input).map_err(|e| format!("Hex decode: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("UTF-8 decode: {e}"))
}
