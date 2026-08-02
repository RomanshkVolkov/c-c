//! MCP server mode: `cac --mcp`.
//!
//! Exposes cac's reports, tasks, notes and device diagnostics to an MCP client
//! (Claude Code / Desktop). Speaks JSON-RPC 2.0 over stdio — one JSON object
//! per line — so **stdout carries protocol only**; every log goes to stderr.
//!
//! Auth is a personal access token (`CAC_TOKEN`), read-only by default: the
//! backend refuses any non-GET made with it unless the token was minted with
//! the specific scope that endpoint needs (see cac's "Connect Claude Code"
//! dialog). Data is always fetched live — freshness is the point.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

const PROTOCOL_VERSION: &str = "2024-11-05";

struct Cfg {
    base: String,
    token: String,
}

fn cfg() -> Result<Cfg, String> {
    let base = std::env::var("CAC_URL")
        .unwrap_or_else(|_| "https://cac.guz-studio.dev".to_string())
        .trim_end_matches('/')
        .to_string();
    let token = std::env::var("CAC_TOKEN")
        .map_err(|_| "CAC_TOKEN is not set (create one in cac → Connect Claude Code)".to_string())?;
    Ok(Cfg { base, token })
}

/// GET a cac API path and return the `data` field of the envelope.
fn api_get(cfg: &Cfg, path: &str) -> Result<Value, String> {
    let url = format!("{}{}", cfg.base, path);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;

    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", cfg.token))
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| format!("bad response from cac: {e}"))?;
        if !status.is_success() {
            let msg = body
                .get("error")
                .and_then(|v| v.as_str())
                .or_else(|| body.get("message").and_then(|v| v.as_str()))
                .unwrap_or("request failed");
            return Err(format!("cac returned {status}: {msg}"));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    })
}

fn api_post(cfg: &Cfg, path: &str, body: Value) -> Result<Value, String> {
    api_write(cfg, "POST", path, body)
}

fn api_patch(cfg: &Cfg, path: &str, body: Value) -> Result<Value, String> {
    api_write(cfg, "PATCH", path, body)
}

/// Any mutating call. Writes need a scope on the token, so a refusal has to say
/// *which* one is missing: "invalid token" and "token lacks a permission" are
/// otherwise indistinguishable, and chasing the wrong one wastes a session.
fn api_write(cfg: &Cfg, method: &str, path: &str, body: Value) -> Result<Value, String> {
    let url = format!("{}{}", cfg.base, path);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;

    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let req = match method {
            "PATCH" => client.patch(&url),
            _ => client.post(&url),
        };
        let res = req
            .header("Authorization", format!("Bearer {}", cfg.token))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| format!("bad response from cac: {e}"))?;
        if !status.is_success() {
            let msg = body
                .get("error")
                .and_then(|v| v.as_str())
                .or_else(|| body.get("message").and_then(|v| v.as_str()))
                .unwrap_or("request failed");
            // The backend answers `missing-scope:<name>`; turn that into the exact
            // remedy instead of making the caller guess.
            if let Some(scope) = msg.strip_prefix("missing-scope:") {
                return Err(format!(
                    "This token is valid but lacks the `{scope}` scope. In cac open Connect Claude Code, \
                     mint a token with that permission checked, and replace CAC_TOKEN."
                ));
            }
            if status.as_u16() == 403 {
                return Err(format!("cac refused the write: {msg}"));
            }
            if status.as_u16() == 401 {
                return Err(format!(
                    "cac rejected the token itself ({msg}) — this is authentication, not a missing \
                     permission. Check CAC_TOKEN is the current one and hasn't expired."
                ));
            }
            return Err(format!("cac returned {status}: {msg}"));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    })
}

/// Reports what a write *would* do, without doing it.
///
/// Exists because the only way to find out whether a token may write used to be
/// to write — which means dirtying someone's board to test a permission. The
/// check is all reads: the token's own scopes from /auth/me, plus the target.
fn dry_run(cfg: &Cfg, scope: &str, target: Result<Value, String>) -> Result<Value, String> {
    let me = api_get(cfg, "/api/v1/auth/me")?;
    let scopes: Vec<String> = me
        .get("scopes")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let permitted = scopes.iter().any(|s| s == scope);
    let (target_ok, target_note) = match target {
        Ok(_) => (true, "found".to_string()),
        Err(e) => (false, e),
    };

    Ok(json!({
        "dryRun": true,
        "wouldSucceed": permitted && target_ok,
        "requiredScope": scope,
        "tokenHasScope": permitted,
        "tokenScopes": scopes,
        "target": target_note,
        "note": if permitted && target_ok {
            "Nothing was written. Re-send without dryRun to apply it."
        } else if !permitted {
            "The token lacks the required scope; mint one in cac → Connect Claude Code."
        } else {
            "The target could not be read; check the id."
        }
    }))
}

fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn arg_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}

/// Append `key=value` to a query string when present.
fn push_q(q: &mut Vec<String>, key: &str, val: Option<String>) {
    if let Some(v) = val {
        q.push(format!("{key}={}", urlencode(&v)));
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn qs(parts: Vec<String>) -> String {
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

// ─── Tools ───────────────────────────────────────────────────────────────────

fn tool_defs() -> Value {
    json!([
        {
            "name": "list_projects",
            "description": "List report projects (client sites / apps) visible to you, with their ids. Use this to resolve a project name to the projectId other tools take.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_reports",
            "description": "List bug reports, newest first. Filter by status (open|in_progress|done|closed — the older names pending/resolved are still accepted and mean open/done), category (bug|ui|performance|data|other), priority (low|medium|high|urgent), reporterId, projectId or date range (RFC3339).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": { "type": "string" },
                    "category": { "type": "string" },
                    "priority": { "type": "string" },
                    "reporterId": { "type": "string", "description": "The host app's own user id, as filed — lists one person's reports." },
                    "projectId": { "type": "string" },
                    "from": { "type": "string", "description": "RFC3339 lower bound" },
                    "to": { "type": "string", "description": "RFC3339 upper bound" },
                    "limit": { "type": "integer", "description": "default 30, max 200" }
                }
            }
        },
        {
            "name": "get_report",
            "description": "Full detail of one report: description, reporter, comment thread and captured telemetry breadcrumbs (network/console/errors leading up to it).",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "list_task_spaces",
            "description": "The task navigator: spaces, folders and lists with their task counts. Use it to resolve a list name to the listId that get_board takes.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_board",
            "description": "A task list's board: its columns (with the statusId update_task takes) and the cards in each, newest first. Use it to see what a team is working on.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "listId": { "type": "string" },
                    "limit": {
                        "type": "integer",
                        "description": "Cards per column, default 50. A long list would otherwise return everything at once."
                    }
                },
                "required": ["listId"]
            }
        },
        {
            "name": "get_task",
            "description": "Full detail of one task: its markdown description, status, priority, tags, assignees, attachments and the comment thread.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "create_task",
            "description": "Create a task in a list. Use list_task_spaces first to resolve the list name to its listId. Needs a token with the `tasks:write` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "listId": { "type": "string", "description": "Target list (from list_task_spaces)." },
                    "title": { "type": "string" },
                    "description": { "type": "string", "description": "Optional markdown body." },
                    "priority": {
                        "type": "string",
                        "enum": ["none", "low", "normal", "high", "urgent"],
                        "description": "Optional; defaults to none."
                    },
                    "idempotencyKey": {
                        "type": "string",
                        "description": "Optional. Reusing the same key in the same list returns the task already created instead of a duplicate — send one if you might retry."
                    },
                    "dryRun": {
                        "type": "boolean",
                        "description": "Validate the target and the token's permission without creating anything."
                    }
                },
                "required": ["listId", "title"]
            }
        },
        {
            "name": "update_task",
            "description": "Change an existing task: title, markdown description, priority, or which column it sits in (statusId, from get_board). Needs a token with the `tasks:manage` scope — separate from creating, because this overwrites work someone else may have written. Only the fields you send are touched.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Task id (from get_board or get_task)." },
                    "title": { "type": "string" },
                    "description": { "type": "string", "description": "Markdown. Replaces the current body — read it with get_task first if you mean to add to it." },
                    "priority": { "type": "string", "enum": ["none", "low", "normal", "high", "urgent"] },
                    "statusId": { "type": "string", "description": "Move the task to this column. get_board returns a statusId per column." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "add_task_comment",
            "description": "Append a markdown comment to a task. Append-only: it cannot overwrite anything, which makes it the right place for an agent to record findings. Needs `tasks:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "body": { "type": "string", "description": "Markdown." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id", "body"]
            }
        },
        {
            "name": "list_devices",
            "description": "Devices sending passive telemetry (mobile apps), with request/error counts and last-seen. Use to find a device to investigate.",
            "inputSchema": {
                "type": "object",
                "properties": { "projectId": { "type": "string" } }
            }
        },
        {
            "name": "get_device_timeline",
            "description": "Diagnostics timeline for a device: errors first, then network activity grouped by endpoint+status, plus device context (OS, app version, network, battery, permissions). Use to root-cause a field incident.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deviceId": { "type": "string" },
                    "sessionId": { "type": "string" },
                    "limit": { "type": "integer", "description": "batches to inspect, default 20" }
                },
                "required": ["deviceId"]
            }
        },
        {
            "name": "list_notes",
            "description": "The full page tree of your private notes, nested under their parent. Use it to resolve a title to the id the other note tools take, and to see what's already there before migrating more content in.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_note",
            "description": "One note's markdown body, its attachments, and which other notes link to it (\"backlinks\"). Use list_notes first to find the id.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "create_note",
            "description": "Create a new, empty page. Use list_notes to find the parentId to nest it under (omit for a root page), then update_note to set its body. Needs a token with the `notes:write` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "parentId": { "type": "string", "description": "Omit for a root-level page." },
                    "dryRun": { "type": "boolean", "description": "Validate the parent and the token's permission without creating anything." }
                },
                "required": ["title"]
            }
        },
        {
            "name": "update_note",
            "description": "Change a note's title, or replace its markdown body outright. Needs a token with the `notes:manage` scope — separate from creating, because this overwrites content that may already be there. If another device saved a different body first, cac keeps that version and puts yours in a new child page instead of overwriting silently; the response's `conflict` field says so when it happens.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string" },
                    "body": { "type": "string", "description": "Markdown. Replaces the current body outright — read it with get_note first if you mean to add to it rather than replace it." },
                    "baseHash": { "type": "string", "description": "The bodyHash from a prior get_note/update_note call on this note, so a real conflict is reported instead of silently overwritten. Omit for a note you just created in this session." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id"]
            }
        }
    ])
}

fn call_tool(cfg: &Cfg, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "list_projects" => {
            let data = api_get(cfg, "/api/v1/report-projects/")?;
            let items: Vec<Value> = data
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|p| {
                    json!({
                        "id": p.get("id"),
                        "name": p.get("name"),
                        "slug": p.get("slug"),
                        "platform": p.get("platform"),
                        "isActive": p.get("isActive"),
                    })
                })
                .collect();
            Ok(json!({ "projects": items }))
        }

        "list_reports" => {
            let mut q = vec![];
            push_q(&mut q, "status", arg_str(args, "status"));
            push_q(&mut q, "category", arg_str(args, "category"));
            push_q(&mut q, "priority", arg_str(args, "priority"));
            push_q(&mut q, "reporterId", arg_str(args, "reporterId"));
            push_q(&mut q, "projectId", arg_str(args, "projectId"));
            push_q(&mut q, "from", arg_str(args, "from"));
            push_q(&mut q, "to", arg_str(args, "to"));
            let limit = arg_i64(args, "limit").unwrap_or(30).clamp(1, 200);
            q.push(format!("limit={limit}"));

            let data = api_get(cfg, &format!("/api/v1/reports/{}", qs(q)))?;
            let empty = vec![];
            let items = data
                .get("items")
                .and_then(|v| v.as_array())
                .unwrap_or(&empty);
            let rows: Vec<Value> = items
                .iter()
                .map(|r| {
                    json!({
                        "id": r.get("id"),
                        "folio": r.get("folio"),
                        "title": r.get("title"),
                        "status": r.get("status"),
                        "category": r.get("category"),
                        "priority": r.get("priority"),
                        "area": r.get("area"),
                        "project": r.get("projectName"),
                        "reporter": r.get("reporterName"),
                        "comments": r.get("commentCount"),
                        "images": r.get("imageCount"),
                        "createdAt": r.get("createdAt"),
                    })
                })
                .collect();
            Ok(json!({ "total": data.get("total"), "reports": rows }))
        }

        "get_report" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let d = api_get(cfg, &format!("/api/v1/reports/{}", urlencode(&id)))?;
            Ok(d)
        }

        "list_task_spaces" => {
            let data = api_get(cfg, "/api/v1/task-spaces/")?;
            Ok(json!({ "spaces": data }))
        }

        "get_board" => {
            let list_id = arg_str(args, "listId").ok_or("listId is required")?;
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(50)
                .clamp(1, 500) as usize;
            let data = api_get(
                cfg,
                &format!("/api/v1/task-lists/{}/board", urlencode(&list_id)),
            )?;
            Ok(summarize_board(&data, limit))
        }

        "get_task" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            api_get(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)))
        }

        "create_task" => {
            let list_id = arg_str(args, "listId").ok_or("listId is required")?;
            let title = arg_str(args, "title").ok_or("title is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(
                    cfg,
                    &format!("/api/v1/task-lists/{}/board", urlencode(&list_id)),
                );
                return dry_run(cfg, "tasks:write", target);
            }
            let mut body = json!({ "title": title });
            if let Some(d) = arg_str(args, "description") {
                body["description"] = json!(d);
            }
            if let Some(p) = arg_str(args, "priority") {
                body["priority"] = json!(p);
            }
            if let Some(k) = arg_str(args, "idempotencyKey") {
                body["idempotencyKey"] = json!(k);
            }
            let data = api_post(cfg, &format!("/api/v1/task-lists/{list_id}/tasks"), body)?;
            // Echo back what was created, including the sequence number, so the
            // caller can refer to the task without another round trip.
            Ok(json!({
                "id": data.get("id"),
                "seq": data.get("seq"),
                "title": data.get("title"),
                "listId": data.get("listId"),
                "statusId": data.get("statusId"),
                "priority": data.get("priority"),
            }))
        }

        "update_task" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)));
                return dry_run(cfg, "tasks:manage", target);
            }
            let mut body = json!({});
            for key in ["title", "description", "priority"] {
                if let Some(v) = arg_str(args, key) {
                    body[key] = json!(v);
                }
            }
            // Moving a card is its own endpoint: the server derives the ordering
            // rank from the neighbours, so a status change can't be a field patch.
            let status_id = arg_str(args, "statusId");
            if body.as_object().map(|o| o.is_empty()).unwrap_or(true) && status_id.is_none() {
                return Err("Nothing to change: send at least one of title, description, priority or statusId".into());
            }

            let mut changed: Vec<&str> = vec![];
            if !body.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                api_patch(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)), body.clone())?;
                changed.extend(body.as_object().unwrap().keys().map(|k| k.as_str()));
            }
            if let Some(status) = status_id {
                // Empty neighbours = drop it at the top of the target column.
                api_post(
                    cfg,
                    &format!("/api/v1/tasks/{}/move", urlencode(&id)),
                    json!({ "statusId": status, "afterId": "", "beforeId": "" }),
                )?;
                changed.push("statusId");
            }
            let after = api_get(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)))?;
            Ok(json!({
                "updated": changed,
                "task": {
                    "id": after.get("task").and_then(|t| t.get("id")),
                    "seq": after.get("task").and_then(|t| t.get("seq")),
                    "title": after.get("task").and_then(|t| t.get("title")),
                    "priority": after.get("task").and_then(|t| t.get("priority")),
                    "column": after.get("status").and_then(|st| st.get("name")),
                    "columnKind": after.get("status").and_then(|st| st.get("kind")),
                }
            }))
        }

        "add_task_comment" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let body_md = arg_str(args, "body").ok_or("body is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)));
                return dry_run(cfg, "tasks:write", target);
            }
            // The endpoint answers with the whole task detail (the app uses it to
            // refresh the drawer), so the new comment is the last of the thread.
            let detail = api_post(
                cfg,
                &format!("/api/v1/tasks/{}/comments", urlencode(&id)),
                json!({ "body": body_md }),
            )?;
            let comments = detail.get("comments").and_then(|v| v.as_array());
            let added = comments.and_then(|c| c.last());
            Ok(json!({
                "id": added.and_then(|c| c.get("id")),
                "author": added.and_then(|c| c.get("authorName")),
                "createdAt": added.and_then(|c| c.get("createdAt")),
                "taskId": id,
                "commentsOnTask": comments.map(|c| c.len()),
            }))
        }

        "list_devices" => {
            let mut q = vec![];
            push_q(&mut q, "projectId", arg_str(args, "projectId"));
            let data = api_get(cfg, &format!("/api/v1/telemetry/devices{}", qs(q)))?;
            Ok(json!({ "devices": data }))
        }

        "get_device_timeline" => {
            let device = arg_str(args, "deviceId").ok_or("deviceId is required")?;
            let limit = arg_i64(args, "limit").unwrap_or(20).clamp(1, 200);
            let mut q = vec![format!("deviceId={}", urlencode(&device))];
            push_q(&mut q, "sessionId", arg_str(args, "sessionId"));
            q.push(format!("limit={limit}"));
            let data = api_get(cfg, &format!("/api/v1/telemetry/timeline{}", qs(q)))?;
            Ok(summarize_timeline(&data))
        }

        "list_notes" => {
            let data = api_get(cfg, "/api/v1/notes/")?;
            Ok(json!({ "tree": build_note_tree(&data) }))
        }

        "get_note" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            api_get(cfg, &format!("/api/v1/notes/{}", urlencode(&id)))
        }

        "create_note" => {
            let title = arg_str(args, "title").ok_or("title is required")?;
            let parent_id = arg_str(args, "parentId");
            if arg_bool(args, "dryRun") {
                let target = match &parent_id {
                    Some(pid) => api_get(cfg, &format!("/api/v1/notes/{}", urlencode(pid))),
                    None => Ok(Value::Null),
                };
                return dry_run(cfg, "notes:write", target);
            }
            let mut body = json!({ "title": title });
            if let Some(pid) = parent_id {
                body["parentId"] = json!(pid);
            }
            let data = api_post(cfg, "/api/v1/notes/", body)?;
            Ok(json!({
                "id": data.get("id"),
                "title": data.get("title"),
                "parentId": data.get("parentId"),
            }))
        }

        "update_note" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/notes/{}", urlencode(&id)));
                return dry_run(cfg, "notes:manage", target);
            }
            let mut body = json!({});
            if let Some(t) = arg_str(args, "title") {
                body["title"] = json!(t);
            }
            if let Some(b) = arg_str(args, "body") {
                body["body"] = json!(b);
            }
            if let Some(h) = arg_str(args, "baseHash") {
                body["baseHash"] = json!(h);
            }
            if body.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                return Err("Nothing to change: send title and/or body".into());
            }
            let data = api_patch(cfg, &format!("/api/v1/notes/{}", urlencode(&id)), body)?;
            let note = data.get("note");
            Ok(json!({
                "id": note.and_then(|n| n.get("id")),
                "title": note.and_then(|n| n.get("title")),
                "bodyHash": note.and_then(|n| n.get("bodyHash")),
                "conflict": data.get("conflict"),
            }))
        }

        other => Err(format!("unknown tool: {other}")),
    }
}

/// Turns the flat (id, parentId) list GET /notes returns into an actual
/// nested tree, root pages first — so the model doesn't have to reconstruct
/// hierarchy from parentId itself the way the app's own navigator does.
fn build_note_tree(flat: &Value) -> Value {
    let empty = vec![];
    let items = flat.as_array().unwrap_or(&empty);

    fn node(item: &Value, items: &[Value]) -> Value {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let children: Vec<Value> = items
            .iter()
            .filter(|c| c.get("parentId").and_then(|v| v.as_str()) == Some(id))
            .map(|c| node(c, items))
            .collect();
        json!({
            "id": item.get("id"),
            "title": item.get("title"),
            "hasBody": item.get("hasBody"),
            "children": children,
        })
    }

    let roots: Vec<Value> = items
        .iter()
        .filter(|i| i.get("parentId").is_none())
        .map(|i| node(i, items))
        .collect();
    json!(roots)
}

/// Group cards under their column so the shape reads like an actual board
/// instead of a flat array the model has to correlate by id.
fn summarize_board(data: &Value, limit: usize) -> Value {
    let empty = vec![];
    let statuses = data
        .get("statuses")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let tasks = data.get("tasks").and_then(|v| v.as_array()).unwrap_or(&empty);

    let columns: Vec<Value> = statuses
        .iter()
        .map(|st| {
            let id = st.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let in_column: Vec<&Value> = tasks
                .iter()
                .filter(|t| t.get("statusId").and_then(|v| v.as_str()) == Some(id))
                .collect();
            let total = in_column.len();
            let cards: Vec<Value> = in_column
                .into_iter()
                .take(limit)
                .map(|t| {
                    json!({
                        "id": t.get("id"),
                        "seq": t.get("seq"),
                        "title": t.get("title"),
                        "priority": t.get("priority"),
                        "dueAt": t.get("dueAt"),
                        "tags": t.get("tags").and_then(|v| v.as_array()).map(|a| {
                            a.iter()
                                .filter_map(|g| g.get("name").and_then(|n| n.as_str()))
                                .collect::<Vec<_>>()
                        }),
                        "assignees": t.get("assignees").and_then(|v| v.as_array()).map(|a| {
                            a.iter()
                                .filter_map(|u| u.get("username").and_then(|n| n.as_str()))
                                .collect::<Vec<_>>()
                        }),
                        "comments": t.get("commentCount"),
                        "hasDescription": t.get("hasDescription"),
                    })
                })
                .collect();
            let shown = cards.len();
            let mut col = json!({
                "column": st.get("name"),
                // The id update_task needs to move a card here. Without it the
                // only way to name a column was to guess its name.
                "statusId": st.get("id"),
                "kind": st.get("kind"),
                "count": total,
                "tasks": cards,
            });
            if shown < total {
                // Say what was dropped: a silent truncation reads as a full board.
                col["truncated"] = json!(format!("showing {shown} of {total}; raise limit to see more"));
            }
            col
        })
        .collect();

    json!({
        "list": data.get("list").and_then(|l| l.get("name")),
        "columns": columns,
        "note": "Call get_task with a task id for its markdown description and comments."
    })
}

/// Compact a raw timeline so it fits a model's context: errors verbatim (that's
/// what you debug with), successful network calls collapsed into per-endpoint
/// counts, and the newest device context kept once instead of per batch.
fn summarize_timeline(data: &Value) -> Value {
    let empty = vec![];
    let batches = data.as_array().unwrap_or(&empty);

    let mut errors: Vec<Value> = vec![];
    let mut net: std::collections::BTreeMap<String, i64> = Default::default();
    let mut other: std::collections::BTreeMap<String, i64> = Default::default();
    let mut device: Option<Value> = None;
    let (mut req_total, mut err_total) = (0i64, 0i64);
    let (mut first_seen, mut last_seen) = (None::<String>, None::<String>);

    for b in batches {
        if device.is_none() {
            if let Some(d) = b.get("device") {
                if !d.is_null() {
                    device = Some(d.clone());
                }
            }
        }
        req_total += b.get("reqCount").and_then(|v| v.as_i64()).unwrap_or(0);
        err_total += b.get("errorCount").and_then(|v| v.as_i64()).unwrap_or(0);
        if let Some(ts) = b.get("receivedAt").and_then(|v| v.as_str()) {
            if last_seen.is_none() {
                last_seen = Some(ts.to_string()); // newest first from the API
            }
            first_seen = Some(ts.to_string());
        }

        for c in b
            .get("breadcrumbs")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty)
        {
            let ctype = c.get("type").and_then(|v| v.as_str()).unwrap_or("log");
            let status = c.get("status").and_then(|v| v.as_i64());
            let is_err = matches!(ctype, "error" | "unhandledrejection" | "exception")
                || (ctype == "network" && matches!(status, Some(s) if s == 0 || s >= 400));

            if is_err {
                if errors.len() < 60 {
                    errors.push(c.clone());
                }
                continue;
            }
            if ctype == "network" {
                let key = format!(
                    "{} {} → {}",
                    c.get("method").and_then(|v| v.as_str()).unwrap_or("?"),
                    c.get("url").and_then(|v| v.as_str()).unwrap_or("?"),
                    status.unwrap_or(0)
                );
                *net.entry(key).or_insert(0) += 1;
            } else {
                // Lifecycle crumbs name the event in `name`; web-style ones use
                // `eventName`. Key on whichever is present so the rollup is legible.
                let label = c
                    .get("eventName")
                    .and_then(|v| v.as_str())
                    .or_else(|| c.get("name").and_then(|v| v.as_str()))
                    .unwrap_or("-");
                let key = format!(
                    "{}/{}",
                    c.get("category").and_then(|v| v.as_str()).unwrap_or(ctype),
                    label
                );
                *other.entry(key).or_insert(0) += 1;
            }
        }
    }

    json!({
        "summary": {
            "batches": batches.len(),
            "requests": req_total,
            "errors": err_total,
            "from": first_seen,
            "to": last_seen,
        },
        "device": device,
        "errors": errors,
        "networkByEndpoint": net,
        "events": other,
        "note": "Errors are verbatim; successful traffic is grouped by endpoint+status. Raise `limit` for more history."
    })
}

// ─── JSON-RPC plumbing ───────────────────────────────────────────────────────

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err(id: Value, code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Tool results are returned as MCP content blocks; `isError` lets the model see
/// and recover from a failure instead of the transport dying.
fn tool_result(value: Result<Value, String>) -> Value {
    match value {
        Ok(v) => json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default() }]
        }),
        Err(e) => json!({
            "content": [{ "type": "text", "text": e }],
            "isError": true
        }),
    }
}

fn handle(req: &Value, cfg: &Result<Cfg, String>) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");

    // Notifications carry no id and expect no response.
    let Some(id) = id else {
        return None;
    };

    match method {
        "initialize" => Some(ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "cac", "version": env!("CARGO_PKG_VERSION") }
            }),
        )),
        "ping" => Some(ok(id, json!({}))),
        "tools/list" => Some(ok(id, json!({ "tools": tool_defs() }))),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let res = match cfg {
                Ok(c) => call_tool(c, name, &args),
                Err(e) => Err(e.clone()),
            };
            Some(ok(id, tool_result(res)))
        }
        other => Some(err(id, -32601, format!("method not found: {other}"))),
    }
}

/// Runs the stdio loop until EOF. Never writes anything but JSON-RPC to stdout.
pub fn serve() {
    let cfg = cfg();
    if let Err(e) = &cfg {
        eprintln!("[cac-mcp] {e}");
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[cac-mcp] bad JSON: {e}");
                continue;
            }
        };
        if let Some(res) = handle(&req, &cfg) {
            if writeln!(stdout, "{res}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
}
