//! The live event stream, owned by Rust.
//!
//! It used to be an `EventSource` in the webview. Two problems with that:
//!
//! 1. `EventSource` can't set headers, so the access token had to ride the query
//!    string — where it lands in the server's access log. Here it's a header.
//! 2. Reconnection, backoff and the missed-ping watchdog all lived in JavaScript,
//!    on top of a connection the webview managed. Now the stream is a task we
//!    control, on the same pooled client as the rest of the app's traffic.
//!
//! Frames are forwarded to the frontend verbatim as `sse://message` events; what
//! each one means stays in the UI, which is where the toasts and refreshes are.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// The server pings every 25s. Two missed pings means the stream is dead even if
/// the socket still looks open — the half-open case that made the app look
/// frozen. Any inbound byte counts as life, not just a ping.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseMessage {
    /// Event name (`report:new`, `task:move`, `ping`, …); "message" when unnamed.
    pub event: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseStatus {
    /// "connecting" · "open" · "down"
    pub state: String,
    pub detail: Option<String>,
}

/// Generation counter: every connect bumps it, and a task whose generation is
/// stale exits. That's how a reconnect (or a sign-out) stops the previous task
/// without needing to cancel a future mid-await.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn emit_status(app: &AppHandle, state: &str, detail: Option<String>) {
    let _ = app.emit(
        "sse://status",
        SseStatus {
            state: state.to_string(),
            detail,
        },
    );
}

/// Opens the stream and keeps it open, reconnecting with capped backoff until a
/// newer generation supersedes this one.
pub fn spawn(app: AppHandle, url: String, token: String) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let client = Arc::new(
        reqwest::Client::builder()
            // No pool_idle_timeout here: this connection is meant to stay open,
            // and the watchdog below is what proves it's still alive.
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default(),
    );

    tauri::async_runtime::spawn(async move {
        let mut attempt: u32 = 0;

        while GENERATION.load(Ordering::SeqCst) == generation {
            emit_status(&app, "connecting", None);

            let res = client
                .get(&url)
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "text/event-stream")
                .send()
                .await;

            match res {
                Ok(resp) if resp.status().is_success() => {
                    attempt = 0;
                    emit_status(&app, "open", None);
                    read_stream(&app, resp, generation).await;
                    // Fell out of the loop: the stream ended or went silent.
                    if GENERATION.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    emit_status(&app, "down", Some("stream ended".into()));
                }
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    emit_status(&app, "down", Some(format!("server returned {status}")));
                    // An auth failure won't fix itself by retrying harder; let the
                    // UI decide (it refreshes the token and reconnects).
                    if status == 401 || status == 403 {
                        return;
                    }
                }
                Err(e) => emit_status(&app, "down", Some(e.to_string())),
            }

            let delay = MAX_BACKOFF.min(Duration::from_secs(1 << attempt.min(5)));
            attempt = attempt.saturating_add(1);
            tokio::time::sleep(delay).await;
        }
    });
}

/// Reads frames until the stream ends, goes quiet for too long, or a newer
/// generation takes over.
async fn read_stream(app: &AppHandle, resp: reqwest::Response, generation: u64) {
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    loop {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }

        let next = tokio::time::timeout(SILENCE_TIMEOUT, stream.next()).await;
        let chunk = match next {
            // Silence: the connection is dead even if nobody said so. Dropping it
            // here is what forces a genuinely fresh socket on the next attempt.
            Err(_) => {
                emit_status(app, "down", Some("no data for 60s".into()));
                return;
            }
            Ok(None) => return,
            Ok(Some(Err(e))) => {
                emit_status(app, "down", Some(e.to_string()));
                return;
            }
            Ok(Some(Ok(bytes))) => bytes,
        };

        buf.push_str(&String::from_utf8_lossy(&chunk));

        // Frames are separated by a blank line; anything after the last one is a
        // partial frame that has to wait for more bytes.
        while let Some(idx) = find_frame_end(&buf) {
            let (frame, rest) = buf.split_at(idx);
            let frame = frame.to_string();
            buf = rest.trim_start_matches(['\r', '\n']).to_string();
            if let Some(msg) = parse_frame(&frame) {
                let _ = app.emit("sse://message", msg);
            }
        }
    }
}

/// Index just past the first frame separator (`\n\n` or `\r\n\r\n`).
fn find_frame_end(buf: &str) -> Option<usize> {
    let a = buf.find("\n\n").map(|i| i + 2);
    let b = buf.find("\r\n\r\n").map(|i| i + 4);
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, y) => x.or(y),
    }
}

/// One SSE frame → an event name and its data. Comment lines (`:`) are ignored,
/// and multi-line `data:` is joined with newlines, per the spec.
fn parse_frame(frame: &str) -> Option<SseMessage> {
    let mut event = String::new();
    let mut data: Vec<&str> = Vec::new();

    for line in frame.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => event = value.to_string(),
            "data" => data.push(value),
            _ => {}
        }
    }

    if event.is_empty() && data.is_empty() {
        return None;
    }
    Some(SseMessage {
        event: if event.is_empty() {
            "message".into()
        } else {
            event
        },
        data: data.join("\n"),
    })
}

/// Stops the current stream: bumping the generation is enough, the task notices
/// on its next turn.
pub fn stop() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_named_event() {
        let m = parse_frame("event: task:move\ndata: {\"listId\":\"l1\"}\n").unwrap();
        assert_eq!(m.event, "task:move");
        assert_eq!(m.data, "{\"listId\":\"l1\"}");
    }

    #[test]
    fn unnamed_events_are_message_and_comments_are_ignored() {
        let m = parse_frame(": keep-alive\ndata: hello\n").unwrap();
        assert_eq!(m.event, "message");
        assert_eq!(m.data, "hello");
        assert!(parse_frame(": just a comment\n").is_none());
    }

    #[test]
    fn joins_multiline_data() {
        let m = parse_frame("event: x\ndata: a\ndata: b\n").unwrap();
        assert_eq!(m.data, "a\nb");
    }

    /// Frames arrive split across chunks; the buffer must only release complete
    /// ones, or half a JSON payload reaches the UI.
    #[test]
    fn only_complete_frames_are_released() {
        let partial = "event: ping\ndata: {\"ts\":1}";
        assert!(find_frame_end(partial).is_none());
        let complete = format!("{partial}\n\nevent: next\n");
        let end = find_frame_end(&complete).expect("first frame is complete");
        assert_eq!(&complete[..end], "event: ping\ndata: {\"ts\":1}\n\n");
    }

    /// The whole pipeline against a running backend: authenticate with a
    /// *header* (the reason this moved out of the webview), open the stream, and
    /// parse a real frame the server emits. Opt-in via CAC_E2E=1.
    #[tokio::test]
    async fn reads_real_frames_from_the_backend() {
        if std::env::var("CAC_E2E").is_err() {
            return;
        }
        let api = "http://localhost:8099/api/v1";
        let http = reqwest::Client::new();

        let login: serde_json::Value = http
            .post(format!("{api}/auth/login"))
            .json(&serde_json::json!({"username":"admin","password":"admin1234"}))
            .send()
            .await
            .expect("login")
            .json()
            .await
            .expect("login json");
        let token = login["data"]["accessToken"].as_str().expect("token").to_string();

        let resp = http
            .get(format!("{api}/events"))
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "text/event-stream")
            .send()
            .await
            .expect("stream opens");
        assert!(resp.status().is_success(), "status {}", resp.status());

        // Provoke an event so the test doesn't wait ~25s for a keep-alive ping.
        let t = token.clone();
        let c = http.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let org: serde_json::Value = c
                .get("http://localhost:8099/api/v1/organizations/")
                .header("Authorization", format!("Bearer {t}"))
                .send().await.unwrap().json().await.unwrap();
            let org_id = org["data"][0]["id"].as_str().unwrap().to_string();
            let sp: serde_json::Value = c
                .post("http://localhost:8099/api/v1/task-spaces/")
                .header("Authorization", format!("Bearer {t}"))
                .json(&serde_json::json!({"orgId": org_id, "name": "sse"}))
                .send().await.unwrap().json().await.unwrap();
            let sp_id = sp["data"]["id"].as_str().unwrap().to_string();
            let li: serde_json::Value = c
                .post(format!("http://localhost:8099/api/v1/task-spaces/{sp_id}/lists"))
                .header("Authorization", format!("Bearer {t}"))
                .json(&serde_json::json!({"name": "l"}))
                .send().await.unwrap().json().await.unwrap();
            let li_id = li["data"]["id"].as_str().unwrap().to_string();
            let _ = c
                .post(format!("http://localhost:8099/api/v1/task-lists/{li_id}/tasks"))
                .header("Authorization", format!("Bearer {t}"))
                .json(&serde_json::json!({"title": "desde sse"}))
                .send().await;
        });

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut seen: Vec<String> = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);

        while tokio::time::Instant::now() < deadline && !seen.iter().any(|e| e == "task:new") {
            let Ok(Some(Ok(chunk))) =
                tokio::time::timeout(Duration::from_secs(20), stream.next()).await
            else {
                break;
            };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = find_frame_end(&buf) {
                let (frame, rest) = buf.split_at(idx);
                let frame = frame.to_string();
                buf = rest.trim_start_matches(['\r', '\n']).to_string();
                if let Some(m) = parse_frame(&frame) {
                    seen.push(m.event);
                }
            }
        }

        assert!(
            seen.iter().any(|e| e == "task:new"),
            "no task:new in {seen:?}"
        );
    }

    #[test]
    fn handles_crlf_separators() {
        let buf = "event: a\r\ndata: 1\r\n\r\n";
        let end = find_frame_end(buf).expect("crlf frame");
        let m = parse_frame(&buf[..end]).unwrap();
        assert_eq!((m.event.as_str(), m.data.as_str()), ("a", "1"));
    }
}
