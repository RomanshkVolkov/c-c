//! The app's own calls to the cac backend.
//!
//! Separate from `http_client`, which powers the Request Client tool: that one
//! is a general-purpose client driven by whatever the user types (follows
//! redirects, fresh client per call, no policy of ours). This one is
//! infrastructure, and it exists to take the app's traffic off the webview's
//! connection pool.
//!
//! Why that matters: with `fetch`, a request over a stale pooled socket — the
//! usual state after the app sits idle and the server closed its side — never
//! settles, and the UI looks frozen. Here the pool is ours: idle sockets are
//! dropped on a schedule we choose, and every request has a hard deadline.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Below the typical 60s server/proxy idle close, so a socket is retired by us
/// before the other end retires it behind our back.
const POOL_IDLE: Duration = Duration::from_secs(30);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequest {
    pub method: String,
    pub url: String,
    /// Header pairs. The access token rides here rather than in the query
    /// string, so it can't end up in an access log.
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub body: String,
}

/// One shared client for the whole app: reqwest keeps the connection pool on
/// it, so building a client per call (as the Request Client does, deliberately)
/// would throw away keep-alive entirely.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .pool_idle_timeout(POOL_IDLE)
                .connect_timeout(CONNECT_TIMEOUT)
                // An API call that redirects is a misconfiguration, not a
                // destination change: better a visible error than a silent hop.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| e.clone())
}

pub async fn execute(req: ApiRequest) -> Result<ApiResponse, String> {
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|_| format!("network: unsupported method {}", req.method))?;

    let mut builder = client()?
        .request(method, &req.url)
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(
            DEFAULT_TIMEOUT.as_millis() as u64,
        )));

    for (k, v) in &req.headers {
        if !k.is_empty() {
            builder = builder.header(k, v);
        }
    }
    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    // The `network:` prefix is a contract with the caller: transport failure, as
    // opposed to a response that merely carries an error status.
    let res = builder.send().await.map_err(|e| {
        let reason = if e.is_timeout() {
            "timed out".to_string()
        } else if e.is_connect() {
            "could not connect".to_string()
        } else {
            e.to_string()
        };
        format!("network: {reason}")
    })?;

    let status = res.status().as_u16();
    let body = res
        .text()
        .await
        .map_err(|e| format!("network: response body: {e}"))?;

    Ok(ApiResponse { status, body })
}


#[cfg(test)]
mod tests {
    use super::*;

    /// The exact payload shape the TypeScript side sends. This is the seam that
    /// silently breaks: `invoke` passes JSON, so a renamed or reshaped field
    /// fails at runtime, not at compile time.
    #[test]
    fn deserializes_the_payload_the_frontend_sends() {
        let json = r#"{
            "method": "POST",
            "url": "https://cac.guz-studio.dev/api/v1/tasks/x/move",
            "headers": [["Content-Type","application/json"],["Authorization","Bearer t"]],
            "body": "{\"statusId\":\"s\"}",
            "timeoutMs": 12000
        }"#;
        let req: ApiRequest = serde_json::from_str(json).expect("payload must parse");
        assert_eq!(req.method, "POST");
        assert_eq!(req.headers.len(), 2);
        assert_eq!(req.headers[1].0, "Authorization");
        assert_eq!(req.timeout_ms, Some(12_000));
    }

    /// A GET with no body and no headers — the common case — must not require
    /// the optional fields to be present at all.
    #[test]
    fn optional_fields_may_be_absent() {
        let req: ApiRequest =
            serde_json::from_str(r#"{"method":"GET","url":"http://x/y"}"#).expect("parse");
        assert!(req.body.is_none());
        assert!(req.headers.is_empty());
        assert!(req.timeout_ms.is_none());
    }

    /// Real round trip against a locally running backend. Skipped unless
    /// CAC_E2E=1 so `cargo test` stays green without one.
    #[tokio::test]
    async fn talks_to_a_real_backend() {
        if std::env::var("CAC_E2E").is_err() {
            return;
        }
        let login = execute(ApiRequest {
            method: "POST".into(),
            url: "http://localhost:8099/api/v1/auth/login".into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: Some(r#"{"username":"admin","password":"admin1234"}"#.into()),
            timeout_ms: Some(10_000),
        })
        .await
        .expect("login must succeed");
        assert_eq!(login.status, 200, "body: {}", login.body);

        let token = login
            .body
            .split("\"accessToken\":\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .expect("token in body")
            .to_string();

        // The token goes in a header — the whole point of moving this to Rust is
        // that it never has to ride the query string.
        let me = execute(ApiRequest {
            method: "GET".into(),
            url: "http://localhost:8099/api/v1/auth/me".into(),
            headers: vec![("Authorization".into(), format!("Bearer {token}"))],
            body: None,
            timeout_ms: Some(10_000),
        })
        .await
        .expect("me must succeed");
        assert_eq!(me.status, 200, "body: {}", me.body);
        assert!(me.body.contains("admin"), "body: {}", me.body);

        // An error status is a response, not a transport failure: it comes back
        // as Ok with the status so the caller can read the message.
        let bad = execute(ApiRequest {
            method: "GET".into(),
            url: "http://localhost:8099/api/v1/auth/me".into(),
            headers: vec![("Authorization".into(), "Bearer nope".into())],
            body: None,
            timeout_ms: Some(10_000),
        })
        .await
        .expect("must be Ok with an error status");
        assert!(bad.status >= 400, "expected 4xx, got {}", bad.status);
    }

    #[tokio::test]
    async fn unreachable_host_is_reported_as_a_transport_failure() {
        // Port 1 refuses immediately: no network round trip, no flakiness.
        let err = execute(ApiRequest {
            method: "GET".into(),
            url: "http://127.0.0.1:1/api/v1/health".into(),
            headers: vec![],
            body: None,
            timeout_ms: Some(2_000),
        })
        .await
        .unwrap_err();
        assert!(err.starts_with("network: "), "unexpected error: {err}");
    }
}