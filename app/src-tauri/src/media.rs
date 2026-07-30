//! Attachment bytes, served to the webview under our own URI scheme.
//!
//! An `<img>` can't set headers, so pointing it straight at the backend forced
//! the access token into the query string — and query strings end up in the
//! server's access log. A custom scheme fixes that without giving up on plain
//! `<img src>`: the webview asks `cacmedia://…`, this handler fetches the bytes
//! with an `Authorization` header, and hands them back.
//!
//! The alternative — fetching into a blob and handing the webview an object URL
//! — means an async image component, revoking URLs by hand, and reimplementing
//! caching. A reference that only lives inside one page has already bitten this
//! app once (pasted images used to be stored as `blob:` URLs).

use std::sync::Mutex;

use tauri::http::{Request, Response};

/// The access token, mirrored from the frontend's auth store.
///
/// The protocol handler runs outside any request the UI made, so it has no way
/// to be handed credentials per call — it needs the current token to be
/// somewhere it can read.
#[derive(Default)]
pub struct Session {
    pub token: Mutex<Option<String>>,
    pub base_url: Mutex<Option<String>>,
}

/// The scheme the webview uses. `convertFileSrc(path, "cacmedia")` on the
/// frontend builds the platform-correct URL for it.
pub const SCHEME: &str = "cacmedia";

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The backend path a `cacmedia://` request is asking for.
///
/// Platforms disagree on the shape (`cacmedia://localhost/<path>` on Linux and
/// macOS, `http://cacmedia.localhost/<path>` on Windows) and the frontend helper
/// percent-encodes the whole path, so both are normalized here.
pub fn backend_path(uri: &str) -> Option<String> {
    let after_scheme = uri
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(uri);
    // Drop the host component, whatever it is.
    let path = after_scheme.split_once('/').map(|(_, p)| p).unwrap_or("");
    let decoded = percent_decode(path);
    let decoded = decoded.trim_start_matches('/');
    if decoded.is_empty() {
        return None;
    }
    let full = format!("/{decoded}");
    // Only our own attachment endpoints, so this can't be turned into an open
    // proxy for arbitrary URLs by anything that can set an <img src>.
    if !full.starts_with("/api/") {
        return None;
    }
    Some(full)
}

fn deny(status: u16) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Fetches the attachment and answers the webview.
pub async fn serve(session_token: Option<String>, base: Option<String>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(path) = backend_path(&req.uri().to_string()) else {
        return deny(400);
    };
    let (Some(token), Some(base)) = (session_token, base) else {
        // No session yet: the UI will re-render once it has one.
        return deny(401);
    };

    let client = reqwest::Client::new();
    let res = match client
        .get(format!("{}{}", base.trim_end_matches('/'), path))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return deny(502),
    };

    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let Ok(bytes) = res.bytes().await else {
        return deny(502);
    };

    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        // The bytes are private; letting the webview cache them to disk would
        // outlive the session that was allowed to see them.
        .header("Cache-Control", "no-store")
        .body(bytes.to_vec())
        .unwrap_or_else(|_| deny(500))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_path_on_linux_and_macos() {
        assert_eq!(
            backend_path("cacmedia://localhost/api/v1/tasks/t1/attachments/a1/raw").as_deref(),
            Some("/api/v1/tasks/t1/attachments/a1/raw")
        );
    }

    #[test]
    fn extracts_the_path_on_windows() {
        assert_eq!(
            backend_path("http://cacmedia.localhost/api/v1/docs/d1/attachments/a1/raw").as_deref(),
            Some("/api/v1/docs/d1/attachments/a1/raw")
        );
    }

    /// convertFileSrc percent-encodes the whole path, slashes included.
    #[test]
    fn decodes_a_percent_encoded_path() {
        assert_eq!(
            backend_path("cacmedia://localhost/%2Fapi%2Fv1%2Ftasks%2Ft1%2Fattachments%2Fa1%2Fraw")
                .as_deref(),
            Some("/api/v1/tasks/t1/attachments/a1/raw")
        );
    }

    /// The handler end to end against a running backend: upload an attachment,
    /// then ask for it the way the webview would and check the bytes come back.
    /// Opt-in via CAC_E2E=1.
    #[tokio::test]
    async fn serves_real_attachment_bytes() {
        if std::env::var("CAC_E2E").is_err() {
            return;
        }
        let api = "http://localhost:8099/api/v1";
        let http = reqwest::Client::new();

        let login: serde_json::Value = http
            .post(format!("{api}/auth/login"))
            .json(&serde_json::json!({"username":"admin","password":"admin1234"}))
            .send().await.unwrap().json().await.unwrap();
        let token = login["data"]["accessToken"].as_str().unwrap().to_string();
        let auth = format!("Bearer {token}");

        let org: serde_json::Value = http.get(format!("{api}/organizations/"))
            .header("Authorization", &auth).send().await.unwrap().json().await.unwrap();
        let org_id = org["data"][0]["id"].as_str().unwrap();
        let sp: serde_json::Value = http.post(format!("{api}/task-spaces/"))
            .header("Authorization", &auth)
            .json(&serde_json::json!({"orgId": org_id, "name": "media"}))
            .send().await.unwrap().json().await.unwrap();
        let sp_id = sp["data"]["id"].as_str().unwrap();
        let li: serde_json::Value = http.post(format!("{api}/task-spaces/{sp_id}/lists"))
            .header("Authorization", &auth)
            .json(&serde_json::json!({"name":"l"}))
            .send().await.unwrap().json().await.unwrap();
        let li_id = li["data"]["id"].as_str().unwrap();
        let tk: serde_json::Value = http.post(format!("{api}/task-lists/{li_id}/tasks"))
            .header("Authorization", &auth)
            .json(&serde_json::json!({"title":"media"}))
            .send().await.unwrap().json().await.unwrap();
        let tk_id = tk["data"]["id"].as_str().unwrap();

        let png: Vec<u8> = base64_decode_png();
        let part = reqwest::multipart::Part::bytes(png.clone())
            .file_name("m.png")
            .mime_str("image/png")
            .unwrap();
        let up: serde_json::Value = http
            .post(format!("{api}/tasks/{tk_id}/attachments"))
            .header("Authorization", &auth)
            .multipart(reqwest::multipart::Form::new().part("file", part))
            .send().await.unwrap().json().await.unwrap();
        let url = up["data"]["url"].as_str().expect("attachment url").to_string();

        // Exactly what the webview requests: our scheme, no credentials in it.
        let req = tauri::http::Request::builder()
            .uri(format!("cacmedia://localhost{url}"))
            .body(Vec::new())
            .unwrap();
        let res = serve(
            Some(token.clone()),
            Some("http://localhost:8099".into()),
            req,
        )
        .await;
        assert_eq!(res.status(), 200, "handler must serve the bytes");
        assert_eq!(res.body(), &png, "bytes must match what was uploaded");
        assert_eq!(
            res.headers().get("Content-Type").unwrap().to_str().unwrap(),
            "image/png"
        );

        // Without a session it must refuse rather than fetch anonymously.
        let req = tauri::http::Request::builder()
            .uri(format!("cacmedia://localhost{url}"))
            .body(Vec::new())
            .unwrap();
        let res = serve(None, Some("http://localhost:8099".into()), req).await;
        assert_eq!(res.status(), 401);
    }

    fn base64_decode_png() -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")
            .unwrap()
    }

    /// Anything outside our API is refused: with an open path this would be a
    /// proxy usable by any markdown someone can paste.
    #[test]
    fn refuses_paths_outside_the_api() {
        assert!(backend_path("cacmedia://localhost/etc/passwd").is_none());
        assert!(backend_path("cacmedia://localhost/").is_none());
        assert!(backend_path("cacmedia://localhost").is_none());
    }
}
