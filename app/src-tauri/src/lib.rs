mod crypto_tools;
mod api_client;
mod media;
mod sse;
mod http_client;
mod image;
mod mcp;
mod notes_export;
mod pty;
mod video_frames;
mod voice;

/// Entry point for `cac --mcp` (stdio MCP server; see `mcp.rs`).
pub fn serve_mcp() {
    mcp::serve();
}

/// Absolute path of the running executable, so the "Connect Claude Code" modal
/// can show a command that's correct on this machine.
#[tauri::command]
fn executable_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "cac-vps";
const GITHUB_API: &str = "https://api.github.com";

fn token_account(server_id: &str) -> String {
    format!("github-token:{server_id}")
}

fn ref_account(server_id: &str) -> String {
    format!("op-reference:{server_id}")
}

fn ssh_key_account(server_id: &str) -> String {
    format!("ssh-key-ref:{server_id}")
}

// In-memory cache: survives the process lifetime, avoids repeated keychain reads
// from async contexts where some Linux keyring backends fail.
struct TokenCache(Mutex<HashMap<String, String>>);

impl TokenCache {
    fn get(&self, server_id: &str) -> Option<String> {
        self.0.lock().ok()?.get(server_id).cloned()
    }

    fn set(&self, server_id: &str, token: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(server_id.to_string(), token.to_string());
        }
    }

    fn remove(&self, server_id: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(server_id);
        }
    }
}

fn keychain_get(server_id: &str) -> Result<String, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &token_account(server_id))
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|e| e.to_string())
}

fn keychain_set(server_id: &str, token: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &token_account(server_id))
        .map_err(|e| e.to_string())?
        .set_password(token)
        .map_err(|e| e.to_string())
}

fn keychain_delete(server_id: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &token_account(server_id))
        .map_err(|e| e.to_string())?
        .delete_credential()
        .map_err(|e| e.to_string())
}

fn keychain_get_ref(server_id: &str) -> Result<String, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &ref_account(server_id))
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|e| e.to_string())
}

fn keychain_set_ref(server_id: &str, reference: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &ref_account(server_id))
        .map_err(|e| e.to_string())?
        .set_password(reference)
        .map_err(|e| e.to_string())
}

fn keychain_delete_ref(server_id: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &ref_account(server_id))
        .map_err(|e| e.to_string())?
        .delete_credential()
        .map_err(|e| e.to_string())
}

// Runs `op read <reference>` and returns the value, with friendly error mapping.
fn op_read(reference: &str) -> Result<String, String> {
    use std::process::Command;

    let output = Command::new("op")
        .args(["read", "--no-newline", reference])
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "1Password CLI (op) not found. Install from https://developer.1password.com/docs/cli/".to_string(),
            _ => format!("Failed to execute op: {e}"),
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.contains("not currently signed in") || stderr.contains("session expired") {
            "1Password session expired. Run `op signin` (or open the 1Password desktop app) and try again.".to_string()
        } else if stderr.is_empty() {
            format!("op read exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(msg);
    }

    let token = String::from_utf8(output.stdout)
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();

    if token.is_empty() {
        return Err("1Password returned an empty value for that reference".into());
    }
    Ok(token)
}

/// One place a secret can be filed: an account and one of its vaults.
#[derive(serde::Serialize)]
struct OpVault {
    account: String, // the sign-in URL, which is what `--account` takes
    email: String,
    vault: String,
}

/// Lists every vault the signed-in accounts can write to.
///
/// Exists because the vault used to be a text box defaulting to "Private", and
/// that only exists in *some* accounts — a personal one has it, a business one
/// typically has "Employee" and named vaults instead. Typing the wrong name
/// failed at save time with a message from `op` that didn't say which of your
/// accounts it had even tried.
///
/// Returns an empty list rather than an error when 1Password isn't reachable:
/// the caller hides the feature instead of showing a scary message next to
/// secrets the user still needs to copy.
#[tauri::command]
fn op_list_vaults() -> Vec<OpVault> {
    use std::process::Command;

    let accounts = match Command::new("op").args(["account", "list", "--format", "json"]).output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => return vec![],
    };
    let accounts: serde_json::Value = match serde_json::from_slice(&accounts) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let mut out = vec![];
    for a in accounts.as_array().unwrap_or(&vec![]) {
        let url = a.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let email = a.get("email").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if url.is_empty() {
            continue;
        }
        let vaults = match Command::new("op")
            .args(["vault", "list", "--account", &url, "--format", "json"])
            .output()
        {
            Ok(o) if o.status.success() => o.stdout,
            // One unreachable account shouldn't hide the others.
            _ => continue,
        };
        let vaults: serde_json::Value = match serde_json::from_slice(&vaults) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for v in vaults.as_array().unwrap_or(&vec![]) {
            if let Some(name) = v.get("name").and_then(|x| x.as_str()) {
                out.push(OpVault {
                    account: url.clone(),
                    email: email.clone(),
                    vault: name.to_string(),
                });
            }
        }
    }
    out
}

/// Stores secrets that are shown exactly once as a new 1Password item, and
/// returns an `op://` reference per field.
///
/// The ingest key and the webhook secret are unrecoverable after the dialog
/// closes: cac keeps only a hash of one and never returns the other. Copying
/// them into a scratch file is what people actually do, so this offers the
/// alternative in the same breath — and hands back references a deploy config
/// can use directly instead of the literal values.
///
/// Values travel in a **0600 temp file passed with `--template`**, never in
/// argv: 1Password's own docs warn that command arguments land in shell history
/// and are readable by other processes. (Assignment statements and a template
/// on stdin were both tried; stdin silently discards the values.)
#[tauri::command]
fn op_item_create(
    title: String,
    account: String,
    vault: String,
    fields: Vec<(String, String)>,
) -> Result<Vec<(String, String)>, String> {
    use std::io::Write as _;
    use std::process::Command;

    if fields.is_empty() {
        return Err("Nothing to save".into());
    }
    if account.trim().is_empty() || vault.trim().is_empty() {
        return Err("Pick an account and a vault first".into());
    }

    let op_err = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => "1Password CLI (op) not found. Install from https://developer.1password.com/docs/cli/".to_string(),
        _ => format!("Failed to execute op: {e}"),
    };
    let friendly = |stderr: &str, status: std::process::ExitStatus| {
        let s = stderr.trim();
        if s.contains("not currently signed in") || s.contains("session expired") {
            "1Password session expired. Run `op signin` (or open the desktop app) and try again.".to_string()
        } else if s.is_empty() {
            format!("op exited with {status}")
        } else {
            s.to_string()
        }
    };

    // Start from the real category template so the item looks native in the app.
    // --account on every call: with more than one account signed in, letting op
    // pick means the item can land somewhere the user never chose.
    let tpl_out = Command::new("op")
        .args(["item", "template", "get", "API Credential", "--account", &account])
        .output()
        .map_err(op_err)?;
    if !tpl_out.status.success() {
        return Err(friendly(&String::from_utf8_lossy(&tpl_out.stderr), tpl_out.status));
    }
    let mut tpl: serde_json::Value = serde_json::from_slice(&tpl_out.stdout)
        .map_err(|e| format!("Unexpected op template: {e}"))?;

    let arr = tpl
        .get_mut("fields")
        .and_then(|f| f.as_array_mut())
        .ok_or("op template has no fields")?;
    for (name, value) in &fields {
        arr.push(serde_json::json!({
            "id": name, "type": "CONCEALED", "label": name, "value": value
        }));
    }

    // 0600 before anything is written, and removed on every path out.
    let path = std::env::temp_dir().join(format!("cac-op-{}.json", ephemeral_suffix()));
    let write_template = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        f.write_all(tpl.to_string().as_bytes())
    };
    write_template().map_err(|e| format!("Could not stage the template: {e}"))?;

    // The category lives in the template; passing --category too is an error.
    let out = Command::new("op")
        .args([
            "item", "create",
            "--account", &account,
            "--vault", &vault,
            "--title", &title,
            "--format", "json",
        ])
        .arg("--template")
        .arg(&path)
        .output();
    let _ = std::fs::remove_file(&path);
    let out = out.map_err(op_err)?;
    if !out.status.success() {
        return Err(friendly(&String::from_utf8_lossy(&out.stderr), out.status));
    }

    // Reference by item id, not title: a title with spaces or a duplicate name
    // would make the reference ambiguous.
    let parsed: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("Unexpected op output: {e}"))?;
    let id = parsed.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    if id.is_empty() {
        return Err("op created the item but returned no id".into());
    }
    Ok(fields
        .iter()
        .map(|(name, _)| (name.clone(), format!("op://{vault}/{id}/{name}")))
        .collect())
}

// ─── SSH agent keys ───────────────────────────────────────────────────────────


// ─── SSH agent discovery ─────────────────────────────────────────────────────
//
// A desktop-launched app does NOT inherit the shell environment, so
// `SSH_AUTH_SOCK` is usually missing and every `ssh`/`ssh-add` call fails with
// "Could not open a connection to your authentication agent" — even though the
// same commands work fine in a terminal. So we locate the socket ourselves and
// hand it to the child process explicitly.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshAgent {
    /// Socket path (or Windows named pipe) to export as SSH_AUTH_SOCK.
    pub socket: String,
    /// Human label: which agent this is and where we found it.
    pub label: String,
    /// How many identities it holds right now.
    pub key_count: usize,
    /// "ok" (holds keys) · "empty" (answers, no keys — usually locked) ·
    /// "refused" (socket file is there but nothing is listening).
    pub status: String,
}

/// Outcome of asking one agent for its identities.
enum AgentProbe {
    Keys(usize),
    /// The socket exists but nothing answered — the classic "1Password isn't
    /// running (or its SSH agent is off)" case, worth reporting differently from
    /// a socket that simply isn't there.
    Refused,
    Missing,
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

/// `IdentityAgent` from ~/.ssh/config — the line 1Password's own setup guide
/// tells people to add, so it's the most reliable hint when it's there.
fn identity_agent_from_ssh_config() -> Option<String> {
    let cfg = home_dir()?.join(".ssh").join("config");
    let text = std::fs::read_to_string(cfg).ok()?;
    parse_identity_agent(&text).map(|v| expand_tilde(&v))
}

/// First uncommented `IdentityAgent` value in an ssh_config. Split out from file
/// access so it can be tested: real configs are full of commented-out variants
/// (`# IdentityAgent ~/.bitwarden-ssh-agent.sock`) and picking one of those up
/// would send us at a socket the user deliberately disabled.
fn parse_identity_agent(text: &str) -> Option<String> {
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('#') {
            continue;
        }
        let lower = l.to_ascii_lowercase();
        let Some(rest) = lower.strip_prefix("identityagent") else {
            continue;
        };
        if !rest.starts_with(|c: char| c.is_whitespace() || c == '=') {
            continue;
        }
        let value = l[l.len() - rest.len()..]
            .trim_start_matches(['=', ' ', '\t'])
            .trim()
            .trim_matches('"');
        if value.is_empty() || value.eq_ignore_ascii_case("none") {
            continue;
        }
        return Some(value.to_string());
    }
    None
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

/// Every socket worth trying, most specific first. Existence is checked by the
/// caller, which also probes each one for keys.
fn agent_candidates() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();

    if let Some(sock) = std::env::var("SSH_AUTH_SOCK").ok().filter(|s| !s.is_empty()) {
        out.push((sock, "Inherited from the environment".into()));
    }
    if let Some(sock) = identity_agent_from_ssh_config() {
        out.push((sock, "IdentityAgent in ~/.ssh/config".into()));
    }
    if let Some(home) = home_dir() {
        #[cfg(target_os = "macos")]
        out.push((
            home.join("Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock")
                .to_string_lossy()
                .to_string(),
            "1Password".into(),
        ));
        out.push((
            home.join(".1password/agent.sock").to_string_lossy().to_string(),
            "1Password".into(),
        ));
    }
    #[cfg(target_os = "windows")]
    out.push((
        r"\\.\pipe\openssh-ssh-agent".into(),
        "Windows OpenSSH agent".into(),
    ));
    if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR") {
        let run = std::path::PathBuf::from(run);
        out.push((
            run.join("ssh-agent.socket").to_string_lossy().to_string(),
            "systemd ssh-agent".into(),
        ));
        out.push((
            run.join("keyring/ssh").to_string_lossy().to_string(),
            "GNOME Keyring".into(),
        ));
        out.push((
            run.join("gcr/ssh").to_string_lossy().to_string(),
            "GNOME Keyring".into(),
        ));
    }

    // Keep the first mention of each socket (earlier = more specific label).
    let mut seen = std::collections::HashSet::new();
    out.retain(|(sock, _)| seen.insert(sock.clone()));
    out
}

/// The socket to use when the caller didn't pick one: the first candidate that
/// actually answers with at least one key, else the first that answers at all.
pub(crate) fn resolve_agent_socket() -> Option<String> {
    let mut answering: Option<String> = None;
    for (sock, _) in agent_candidates() {
        match probe_agent(&sock) {
            AgentProbe::Keys(n) if n > 0 => return Some(sock),
            AgentProbe::Keys(_) => {
                answering.get_or_insert(sock);
            }
            _ => continue,
        }
    }
    answering
}

fn probe_agent(socket: &str) -> AgentProbe {
    let exists = std::path::Path::new(socket).exists() || socket.starts_with(r"\\.\pipe\");
    let Ok(out) = std::process::Command::new("ssh-add")
        .arg("-l")
        .env("SSH_AUTH_SOCK", socket)
        .output()
    else {
        return AgentProbe::Missing;
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stdout.contains("no identities") || stderr.contains("no identities") {
        return AgentProbe::Keys(0);
    }
    if !out.status.success() {
        return if exists { AgentProbe::Refused } else { AgentProbe::Missing };
    }
    AgentProbe::Keys(stdout.lines().filter(|l| !l.trim().is_empty()).count())
}

/// Agents the machine actually has, so the UI can let the user choose (a laptop
/// with both 1Password and GNOME Keyring running has two, holding different
/// keys). Only reachable ones are returned.
#[tauri::command]
fn list_ssh_agents() -> Vec<SshAgent> {
    agent_candidates()
        .into_iter()
        .filter_map(|(socket, label)| match probe_agent(&socket) {
            AgentProbe::Keys(n) => Some(SshAgent {
                socket,
                label,
                key_count: n,
                status: if n > 0 { "ok".into() } else { "empty".into() },
            }),
            // Surfaced on purpose: "1Password is installed but not answering" is
            // something the user can fix, unlike a path that was never there.
            AgentProbe::Refused => Some(SshAgent {
                socket,
                label,
                key_count: 0,
                status: "refused".into(),
            }),
            AgentProbe::Missing => None,
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyItem {
    /// Full public key line, e.g. "ssh-ed25519 AAAA… title".
    pub public_key: String,
    /// The agent's comment — for 1Password this is the item title.
    pub title: String,
    pub fingerprint: String,
    pub key_type: String,
}

fn run_ssh_add(flag: &str, socket: Option<&str>) -> Result<String, String> {
    use std::process::Command;

    let mut cmd = Command::new("ssh-add");
    cmd.arg(flag);
    // Explicit socket: the inherited environment can't be trusted in a
    // desktop-launched app (see agent discovery above).
    if let Some(sock) = socket {
        cmd.env("SSH_AUTH_SOCK", sock);
    }
    let output = cmd
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "`ssh-add` not found on PATH.".to_string(),
            _ => format!("Failed to execute ssh-add: {e}"),
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // ssh-add exits non-zero when the agent holds nothing or is unreachable.
        if stdout.contains("no identities") || stderr.contains("no identities") {
            return Ok(String::new());
        }
        return Err(if stderr.is_empty() {
            no_agent_message()
        } else if stderr.contains("Could not open a connection") {
            // The generic ssh-add wording is a dead end for the user: say which
            // sockets were tried and what to do about it.
            format!("{stderr}\n\n{}", no_agent_message())
        } else {
            stderr
        });
    }
    Ok(stdout)
}


/// What to tell the user when no agent answers. Lists the sockets we tried,
/// because "could not open a connection" alone gives them nothing to act on.
fn no_agent_message() -> String {
    let mut refused = Vec::new();
    let mut tried = Vec::new();
    for (sock, label) in agent_candidates() {
        match probe_agent(&sock) {
            AgentProbe::Refused => refused.push(format!("{label} ({sock})")),
            _ => tried.push(format!("  • {sock}  ({label})")),
        }
    }
    if !refused.is_empty() {
        return format!(
            "Found an agent socket but nothing is listening on it:\n  • {}\n\n\
             That usually means the app that owns it isn't running — for 1Password, \
             open it, unlock it, and check Settings → Developer → \"Use the SSH agent\".",
            refused.join("\n  • ")
        );
    }
    format!(
        "No SSH agent answered. Tried:\n{}\n\nIf you use 1Password, turn on \
         Settings → Developer → \"Use the SSH agent\", then reopen this dialog.",
        tried.join("\n")
    )
}

/// Lists the keys the SSH agent currently holds — for a 1Password agent, that's
/// the keys from the enabled vaults, with the item title as the comment.
///
/// This deliberately does NOT shell out to `op`: the 1Password CLI's desktop-app
/// integration validates the process that invokes it and refuses when launched
/// from a GUI app ("connecting to desktop app: connection reset"), while the
/// agent socket works fine from the same context — it's what ssh already uses.
#[tauri::command]
fn list_agent_ssh_keys(socket: Option<String>) -> Result<Vec<SshKeyItem>, String> {
    let sock = socket
        .filter(|s| !s.is_empty())
        .or_else(resolve_agent_socket)
        .ok_or_else(no_agent_message)?;
    let listing = run_ssh_add("-L", Some(&sock))?; // public key material + comment
    let prints = run_ssh_add("-l", Some(&sock)).unwrap_or_default(); // same order

    // "256 SHA256:… comment (ED25519)" → fingerprint by position.
    let fingerprints: Vec<String> = prints
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            l.split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_string()
        })
        .collect();

    Ok(listing
        .lines()
        .filter(|l| l.starts_with("ssh-") || l.starts_with("ecdsa-"))
        .enumerate()
        .map(|(i, line)| {
            let mut parts = line.splitn(3, ' ');
            let key_type = parts.next().unwrap_or_default().to_string();
            let _material = parts.next().unwrap_or_default();
            let title = parts.next().unwrap_or("(no title)").trim().to_string();
            SshKeyItem {
                public_key: line.to_string(),
                title: if title.is_empty() { "(no title)".into() } else { title },
                fingerprint: fingerprints.get(i).cloned().unwrap_or_default(),
                key_type,
            }
        })
        .collect())
}

/// A public key materialized on disk only for the lifetime of one ssh call.
/// ssh needs an `IdentityFile` path; the file holds the PUBLIC half only (the
/// private key never leaves the agent, which does the signing) and is removed as
/// soon as the command returns.
pub(crate) struct EphemeralIdentity {
    pub(crate) path: std::path::PathBuf,
}

impl Drop for EphemeralIdentity {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) fn stage_public_key(public_key: &str) -> Result<EphemeralIdentity, String> {
    let key = public_key.trim();
    if !key.starts_with("ssh-") && !key.starts_with("ecdsa-") {
        return Err("Stored SSH identity is not a public key".into());
    }

    let mut path = std::env::temp_dir();
    path.push(format!("cac-ssh-{}.pub", ephemeral_suffix()));
    std::fs::write(&path, format!("{key}\n"))
        .map_err(|e| format!("Could not stage the public key: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(EphemeralIdentity { path })
}

pub(crate) fn ephemeral_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{}", std::process::id())
}

#[tauri::command]
fn set_server_ssh_key(server_id: String, public_key: String) -> Result<(), String> {
    if public_key.trim().is_empty() {
        return keyring::Entry::new(KEYCHAIN_SERVICE, &ssh_key_account(&server_id))
            .map_err(|e| e.to_string())?
            .delete_credential()
            .or(Ok(()));
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, &ssh_key_account(&server_id))
        .map_err(|e| e.to_string())?
        .set_password(public_key.trim())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_server_ssh_key(server_id: String) -> Result<Option<String>, String> {
    stored_ssh_key(&server_id)
}

/// La misma lectura, llamable desde Rust. El comando de arriba no sirve: la
/// macro de tauri le cuelga un re-export con su nombre, y hacerlo visible al
/// resto del crate choca con él.
pub(crate) fn stored_ssh_key(server_id: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &ssh_key_account(server_id))
        .map_err(|e| e.to_string())?
        .get_password()
    {
        Ok(v) => Ok(Some(v)),
        Err(_) => Ok(None),
    }
}

// ─── SSH agent operations ─────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct SshOutput {
    pub stdout: String,
    pub stderr: String,
}

const AGENT_IMAGE: &str = "ghcr.io/romanshkvolkov/c-c/swarm-manage:latest";

// Runs `ssh` against the given target, executing one remote command.
// Authentication is provided by the OS SSH agent (`SSH_AUTH_SOCK`, e.g. 1Password).
// StrictHostKeyChecking=accept-new pins unknown hosts on first connect.
fn ssh_run(
    host: &str,
    port: u16,
    user: &str,
    remote_cmd: &str,
    identity: Option<&str>,
) -> Result<SshOutput, String> {
    use std::process::Command;

    let target = format!("{user}@{host}");
    let port_str = port.to_string();

    let mut args: Vec<String> = vec![
        "-p".into(),
        port_str,
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ConnectTimeout=15".into(),
    ];

    // Pin a single key. An agent holding many keys (1Password vaults often do)
    // makes ssh offer them one by one until the server's MaxAuthTries (6 by
    // default) trips "Too many authentication failures" — before it ever reaches
    // the right one. With the 1Password agent the identity is the **public** key
    // file: ssh then asks the agent for just that one.
    if let Some(id) = identity.filter(|s| !s.trim().is_empty()) {
        args.push("-i".into());
        args.push(id.trim().to_string());
        args.push("-o".into());
        args.push("IdentitiesOnly=yes".into());
    }

    args.push(target);
    args.push(remote_cmd.to_string());

    let mut cmd = Command::new("ssh");
    cmd.args(&args);
    // Same reason as ssh-add: without this the desktop-launched app has no agent
    // and every connection fails with "Permission denied (publickey)".
    if let Some(sock) = resolve_agent_socket() {
        cmd.env("SSH_AUTH_SOCK", sock);
    }
    let output = cmd
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                "`ssh` binary not found on PATH.".to_string()
            }
            _ => format!("Failed to execute ssh: {e}"),
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let trimmed = stderr.trim();
        let hint = if trimmed.contains("Too many authentication failures") {
            " (your SSH agent offered more keys than the server allows before the right one. Pick this server's key with the key button in the servers table so cac offers only that one)"
        } else if trimmed.contains("Permission denied") {
            " (is your 1Password SSH agent unlocked and the key authorized on this server?)"
        } else if trimmed.contains("Connection refused") || trimmed.contains("Connection timed out") {
            " (host unreachable or SSH port closed)"
        } else {
            ""
        };
        return Err(format!(
            "ssh exited with status {}{}\n{}",
            output.status, hint, trimmed
        ));
    }

    Ok(SshOutput { stdout, stderr })
}

#[tauri::command]
fn update_swarm_manage_agent(
    host: String,
    ssh_port: u16,
    ssh_user: String,
    service: Option<String>,
    // Public key line of the agent key to pin (see list_agent_ssh_keys).
    identity_key: Option<String>,
) -> Result<SshOutput, String> {
    let service_name = service.unwrap_or_else(|| "cac_swarm-manage".to_string());
    let remote = format!(
        "docker service update --force --image {AGENT_IMAGE} {service_name}"
    );
    {
        // Resolve (and stage) the key only for this call; the guard wipes it.
        let staged = match identity_key.as_deref().filter(|k| !k.trim().is_empty()) {
            Some(k) => Some(stage_public_key(k)?),
            None => None,
        };
        let identity = staged.as_ref().map(|s| s.path.to_string_lossy().into_owned());
        ssh_run(&host, ssh_port, &ssh_user, &remote, identity.as_deref())
    }
}

#[tauri::command]
fn deploy_swarm_manage_agent(
    host: String,
    ssh_port: u16,
    ssh_user: String,
    agent_port: u16,
    stack: Option<String>,
    // Public key line of the agent key to pin (see list_agent_ssh_keys).
    identity_key: Option<String>,
) -> Result<SshOutput, String> {
    let stack_name = stack.unwrap_or_else(|| "cac".to_string());
    let compose = format!(
        "version: '3.8'
services:
  swarm-manage:
    image: {AGENT_IMAGE}
    ports:
      - \"{agent_port}:9090\"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
"
    );
    let remote = format!(
        "set -e
cat > /tmp/swarm-manage.yml <<'EOF'
{compose}EOF
docker stack deploy -c /tmp/swarm-manage.yml {stack_name}
rm -f /tmp/swarm-manage.yml"
    );
    {
        // Resolve (and stage) the key only for this call; the guard wipes it.
        let staged = match identity_key.as_deref().filter(|k| !k.trim().is_empty()) {
            Some(k) => Some(stage_public_key(k)?),
            None => None,
        };
        let identity = staged.as_ref().map(|s| s.path.to_string_lossy().into_owned());
        ssh_run(&host, ssh_port, &ssh_user, &remote, identity.as_deref())
    }
}

// ─── Keychain commands ────────────────────────────────────────────────────────

#[tauri::command]
fn set_github_token(
    server_id: String,
    token: String,
    cache: tauri::State<TokenCache>,
) -> Result<(), String> {
    keychain_set(&server_id, &token)?;
    cache.set(&server_id, &token);
    Ok(())
}

#[tauri::command]
fn delete_github_token(server_id: String, cache: tauri::State<TokenCache>) -> Result<(), String> {
    cache.remove(&server_id);
    let _ = keychain_delete_ref(&server_id);
    keychain_delete(&server_id)
}

#[tauri::command]
fn load_github_token_from_1password(
    server_id: String,
    op_reference: String,
    cache: tauri::State<TokenCache>,
) -> Result<(), String> {
    let token = op_read(&op_reference)?;
    keychain_set(&server_id, &token)?;
    let _ = keychain_set_ref(&server_id, &op_reference);
    cache.set(&server_id, &token);
    Ok(())
}

#[tauri::command]
fn refresh_github_token_from_1password(
    server_id: String,
    cache: tauri::State<TokenCache>,
) -> Result<(), String> {
    let reference = keychain_get_ref(&server_id)
        .map_err(|_| "No 1Password reference saved for this server. Use 'Load from 1Password' first.".to_string())?;
    let token = op_read(&reference)?;
    keychain_set(&server_id, &token)?;
    cache.set(&server_id, &token);
    Ok(())
}

#[tauri::command]
fn get_op_reference(server_id: String) -> Option<String> {
    keychain_get_ref(&server_id).ok()
}

#[tauri::command]
fn clear_op_reference(server_id: String) -> Result<(), String> {
    keychain_delete_ref(&server_id)
}

#[tauri::command]
fn github_token_configured(server_id: String, cache: tauri::State<TokenCache>) -> bool {
    if cache.get(&server_id).is_some() {
        return true;
    }
    // Try loading from keychain and warming the cache
    if let Ok(token) = keychain_get(&server_id) {
        cache.set(&server_id, &token);
        return true;
    }
    false
}

// Retrieve token: cache-first, then keychain fallback
fn get_token(server_id: &str, cache: &TokenCache) -> Result<String, String> {
    if let Some(t) = cache.get(server_id) {
        return Ok(t);
    }
    let t = keychain_get(server_id)?;
    cache.set(server_id, &t);
    Ok(t)
}

// ─── Domain types ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct GitHubSecret {
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct GitHubVariable {
    pub name: String,
    pub value: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct SecretsPage {
    secrets: Vec<GitHubSecret>,
}

#[derive(Deserialize)]
struct VariablesPage {
    variables: Vec<GitHubVariable>,
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

fn gh_client(token: &str) -> Result<reqwest::Client, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION};

    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|e| e.to_string())?,
    );
    headers.insert(
        HeaderName::from_static("x-github-api-version"),
        HeaderValue::from_static("2022-11-28"),
    );
    headers.insert(
        HeaderName::from_static("user-agent"),
        HeaderValue::from_static("cac_desktop_application"),
    );

    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

async fn gh_get<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
) -> Result<T, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API {status}: {body}"));
    }
    resp.json::<T>().await.map_err(|e| e.to_string())
}

async fn gh_send(req: reqwest::RequestBuilder, expected: &[u16]) -> Result<(), String> {
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if !expected.contains(&status) {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API {status}: {body}"));
    }
    Ok(())
}

// ─── NaCl sealed box (crypto_box_seal, libsodium-compatible) ─────────────────

fn seal_box(recipient_pub_b64: &str, plaintext: &[u8]) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use blake2::{
        digest::{Update, VariableOutput},
        Blake2bVar,
    };
    use crypto_box::{aead::Aead, PublicKey, SalsaBox, SecretKey};
    use rand::rngs::OsRng;

    let pub_bytes = STANDARD
        .decode(recipient_pub_b64)
        .map_err(|e| e.to_string())?;
    let pub_array: [u8; 32] = pub_bytes
        .try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())?;
    let recipient_pub = PublicKey::from(pub_array);

    let eph_priv = SecretKey::generate(&mut OsRng);
    let eph_pub = eph_priv.public_key();

    // nonce = BLAKE2b-192(eph_pub || recipient_pub) — matches libsodium crypto_box_seal
    let mut hasher = Blake2bVar::new(24).map_err(|e| e.to_string())?;
    hasher.update(eph_pub.as_bytes());
    hasher.update(recipient_pub.as_bytes());
    let mut nonce_bytes = [0u8; 24];
    hasher
        .finalize_variable(&mut nonce_bytes)
        .map_err(|e| e.to_string())?;
    let nonce = crypto_box::Nonce::from_slice(&nonce_bytes);

    let nacl_box = SalsaBox::new(&recipient_pub, &eph_priv);
    let ciphertext = nacl_box
        .encrypt(nonce, plaintext)
        .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(32 + ciphertext.len());
    out.extend_from_slice(eph_pub.as_bytes());
    out.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(out))
}

// ─── GitHub API commands ──────────────────────────────────────────────────────

#[tauri::command]
async fn list_github_secrets(
    server_id: String,
    owner: String,
    repo: String,
    cache: tauri::State<'_, TokenCache>,
) -> Result<Vec<GitHubSecret>, String> {
    let client = gh_client(&get_token(&server_id, &cache)?)?;
    let page: SecretsPage = gh_get(
        &client,
        &format!("{GITHUB_API}/repos/{owner}/{repo}/actions/secrets"),
    )
    .await?;
    Ok(page.secrets)
}

#[tauri::command]
async fn list_github_variables(
    server_id: String,
    owner: String,
    repo: String,
    cache: tauri::State<'_, TokenCache>,
) -> Result<Vec<GitHubVariable>, String> {
    let client = gh_client(&get_token(&server_id, &cache)?)?;
    let page: VariablesPage = gh_get(
        &client,
        &format!("{GITHUB_API}/repos/{owner}/{repo}/actions/variables"),
    )
    .await?;
    Ok(page.variables)
}

#[tauri::command]
async fn set_github_secret(
    server_id: String,
    owner: String,
    repo: String,
    name: String,
    value: String,
    cache: tauri::State<'_, TokenCache>,
) -> Result<(), String> {
    let client = gh_client(&get_token(&server_id, &cache)?)?;

    #[derive(Deserialize)]
    struct PubKey {
        key_id: String,
        key: String,
    }
    let pk: PubKey = gh_get(
        &client,
        &format!("{GITHUB_API}/repos/{owner}/{repo}/actions/secrets/public-key"),
    )
    .await?;

    let encrypted = seal_box(&pk.key, value.as_bytes())?;
    let body = serde_json::json!({ "encrypted_value": encrypted, "key_id": pk.key_id });
    gh_send(
        client
            .put(format!(
                "{GITHUB_API}/repos/{owner}/{repo}/actions/secrets/{name}"
            ))
            .json(&body),
        &[201, 204],
    )
    .await
}

#[tauri::command]
async fn set_github_variable(
    server_id: String,
    owner: String,
    repo: String,
    name: String,
    value: String,
    exists: bool,
    cache: tauri::State<'_, TokenCache>,
) -> Result<(), String> {
    let client = gh_client(&get_token(&server_id, &cache)?)?;
    let body = serde_json::json!({ "name": name, "value": value });
    let req = if exists {
        client
            .patch(format!(
                "{GITHUB_API}/repos/{owner}/{repo}/actions/variables/{name}"
            ))
            .json(&body)
    } else {
        client
            .post(format!(
                "{GITHUB_API}/repos/{owner}/{repo}/actions/variables"
            ))
            .json(&body)
    };
    gh_send(req, &[200, 201, 204]).await
}

#[tauri::command]
async fn delete_github_secret(
    server_id: String,
    owner: String,
    repo: String,
    name: String,
    cache: tauri::State<'_, TokenCache>,
) -> Result<(), String> {
    let client = gh_client(&get_token(&server_id, &cache)?)?;
    gh_send(
        client.delete(format!(
            "{GITHUB_API}/repos/{owner}/{repo}/actions/secrets/{name}"
        )),
        &[204],
    )
    .await
}

#[tauri::command]
async fn delete_github_variable(
    server_id: String,
    owner: String,
    repo: String,
    name: String,
    cache: tauri::State<'_, TokenCache>,
) -> Result<(), String> {
    let client = gh_client(&get_token(&server_id, &cache)?)?;
    gh_send(
        client.delete(format!(
            "{GITHUB_API}/repos/{owner}/{repo}/actions/variables/{name}"
        )),
        &[204],
    )
    .await
}

// ─── Image compression ───────────────────────────────────────────────────────

#[tauri::command]
async fn compress_image(
    data: Vec<u8>,
    quality: Option<u8>,
    max_width: Option<u32>,
    format: String,
) -> Result<image::CompressResult, String> {
    let fmt: image::OutputFormat =
        serde_json::from_value(serde_json::Value::String(format))
            .map_err(|e| format!("Invalid format: {e}"))?;

    let opts = image::CompressOptions {
        quality,
        max_width,
        format: fmt,
    };

    tokio::task::spawn_blocking(move || image::compress(&data, &opts))
        .await
        .map_err(|e| e.to_string())?
}

// ─── Crypto tools ────────────────────────────────────────────────────────────

#[tauri::command]
fn jwt_decode(
    token: String,
    secret: Option<String>,
    algorithm: Option<String>,
) -> crypto_tools::JwtDecoded {
    crypto_tools::jwt_decode(&token, secret.as_deref(), algorithm.as_deref())
}

#[tauri::command]
fn generate_id(kind: String) -> Result<String, String> {
    match kind.as_str() {
        "uuid-v4" => Ok(crypto_tools::generate_uuid_v4()),
        "uuid-v7" => Ok(crypto_tools::generate_uuid_v7()),
        "cuid2" => Ok(crypto_tools::generate_cuid2()),
        _ => Err(format!("Unknown id kind: {kind}")),
    }
}

#[tauri::command]
fn hash_text(input: String, algorithm: String) -> Result<crypto_tools::HashResult, String> {
    crypto_tools::hash_text(&input, &algorithm)
}

#[tauri::command]
fn hmac_sign(
    input: String,
    key: String,
    algorithm: String,
) -> Result<crypto_tools::HashResult, String> {
    crypto_tools::hmac_sign(&input, &key, &algorithm)
}

#[tauri::command]
fn bcrypt_hash(input: String, cost: Option<u32>) -> Result<String, String> {
    crypto_tools::bcrypt_hash(&input, cost.unwrap_or(12))
}

#[tauri::command]
fn bcrypt_verify(input: String, hash: String) -> Result<bool, String> {
    crypto_tools::bcrypt_verify(&input, &hash)
}

#[tauri::command]
fn argon2_hash(input: String) -> Result<String, String> {
    crypto_tools::argon2_hash(&input)
}

#[tauri::command]
fn argon2_verify(input: String, hash: String) -> Result<bool, String> {
    crypto_tools::argon2_verify(&input, &hash)
}

#[tauri::command]
fn encode_decode(input: String, codec: String, direction: String) -> Result<String, String> {
    match (codec.as_str(), direction.as_str()) {
        ("base64", "encode") => Ok(crypto_tools::base64_encode(&input)),
        ("base64", "decode") => crypto_tools::base64_decode(&input),
        ("url", "encode") => Ok(crypto_tools::url_encode(&input)),
        ("url", "decode") => crypto_tools::url_decode(&input),
        ("hex", "encode") => Ok(crypto_tools::hex_encode(&input)),
        ("hex", "decode") => crypto_tools::hex_decode(&input),
        _ => Err(format!("Unknown codec/direction: {codec}/{direction}")),
    }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/// The app's own backend calls. Routed through Rust so they don't ride the
/// webview's connection pool — see api_client for why that matters.
#[tauri::command]
async fn api_request(req: api_client::ApiRequest) -> Result<api_client::ApiResponse, String> {
    api_client::execute(req).await
}

/// Mirrors the frontend's session into Rust. The media protocol handler runs
/// outside any UI request, so it has no other way to learn the current token.
#[tauri::command]
fn set_session(state: tauri::State<'_, media::Session>, token: Option<String>, base_url: Option<String>) {
    if let Ok(mut t) = state.token.lock() {
        *t = token;
    }
    if let Ok(mut b) = state.base_url.lock() {
        *b = base_url;
    }
}

/// Downloads an attachment to a temp file and hands it to the OS.
///
/// A `cacmedia://` URL is only meaningful inside this webview, so links to
/// non-image files can't just be opened in the browser — and doing it this way
/// keeps the token out of any URL, which is the point of the exercise.
#[tauri::command]
async fn open_attachment(
    app: tauri::AppHandle,
    state: tauri::State<'_, media::Session>,
    path: String,
    file_name: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let token = state.token.lock().ok().and_then(|t| t.as_ref().cloned());
    let base = state.base_url.lock().ok().and_then(|b| b.as_ref().cloned());
    let (Some(token), Some(base)) = (token, base) else {
        return Err("Not signed in".into());
    };
    let path = media::backend_path(&format!("cacmedia://localhost{path}"))
        .ok_or_else(|| "Not an attachment path".to_string())?;

    let res = reqwest::Client::new()
        .get(format!("{}{}", base.trim_end_matches('/'), path))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("Could not download: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Server returned {}", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;

    let safe: String = file_name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' '))
        .collect();
    let mut target = std::env::temp_dir();
    target.push(format!("cac-{}-{}", ephemeral_suffix(), if safe.is_empty() { "file".into() } else { safe }));
    std::fs::write(&target, &bytes).map_err(|e| format!("Could not write the file: {e}"))?;

    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("Could not open it: {e}"))
}

/// Opens the live event stream. Idempotent: connecting again replaces the
/// previous stream, which is what a token refresh needs.
#[tauri::command]
fn sse_connect(app: tauri::AppHandle, url: String, token: String) {
    sse::spawn(app, url, token);
}

#[tauri::command]
fn sse_disconnect() {
    sse::stop();
}

// ─── HTTP client (Request Client tool) ───────────────────────────────────────

#[tauri::command]
async fn send_http_request(
    method: String,
    url: String,
    headers: Vec<http_client::KeyValue>,
    body: Option<String>,
) -> Result<http_client::HttpResponse, String> {
    let m: http_client::HttpMethod =
        serde_json::from_value(serde_json::Value::String(method))
            .map_err(|e| format!("Invalid method: {e}"))?;

    let req = http_client::HttpRequest {
        method: m,
        url,
        headers,
        body,
    };

    http_client::execute(req).await
}

// ─── File save ───────────────────────────────────────────────────────────────

#[tauri::command]
async fn save_file(
    app: tauri::AppHandle,
    data: Vec<u8>,
    file_name: String,
    filter_name: String,
    filter_ext: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    let path = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter(&filter_name, &[&filter_ext])
        .blocking_save_file();

    let Some(path) = path else {
        return Ok(false);
    };

    std::fs::write(path.as_path().ok_or("Invalid path")?, &data)
        .map_err(|e| e.to_string())?;

    Ok(true)
}

// ─── Notes export ────────────────────────────────────────────────────────────

/// Asks for a folder and writes every note into it as markdown.
///
/// Returns `None` when the user dismissed the picker, so the UI can stay quiet
/// instead of reporting a cancellation as a failure.
#[tauri::command]
async fn export_notes(
    app: tauri::AppHandle,
    state: tauri::State<'_, media::Session>,
    subfolder: String,
) -> Result<Option<notes_export::ExportSummary>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Copied out before the await: the guard is not Send, and holding it across
    // one would make this command fail to compile.
    let token = state.token.lock().ok().and_then(|t| t.as_ref().cloned());
    let base = state.base_url.lock().ok().and_then(|b| b.as_ref().cloned());
    let (Some(token), Some(base)) = (token, base) else {
        return Err("Not signed in".into());
    };

    let Some(chosen) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let chosen = chosen.into_path().map_err(|e| e.to_string())?;

    // Everything lands in one new subfolder rather than loose in whatever the
    // user picked: an export writes a whole tree, and scattering it across an
    // existing Documents folder would be hard to undo.
    let dest = chosen.join(sanitize_component(&subfolder, "cac-notes"));
    std::fs::create_dir_all(&dest).map_err(|e| format!("Could not create {dest:?}: {e}"))?;

    notes_export::run(&base, &token, dest).await.map(Some)
}

/// One path component, with anything that could escape it removed.
fn sanitize_component(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' '))
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

// ─── App entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Las sesiones de terminal se matan al cerrar la ventana. En Unix el
        // `ssh` moriría igual al soltarse el pty, pero apoyarse en eso es
        // apostar a en qué orden se destruyen los descriptores al salir.
        .on_window_event(|_, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                pty::close_all();
                // Igual que el pty: una sala abierta y un micrófono vivo en un
                // proceso que ya nadie mira es peor que un recurso filtrado.
                voice::close_all();
            }
        })
        .manage(TokenCache(Mutex::new(HashMap::new())))
        .manage(media::Session::default())
        // Attachments are served under our own scheme so an <img> can carry
        // credentials in a header instead of the URL. See media.rs.
        .register_asynchronous_uri_scheme_protocol(
            video_frames::SCHEME,
            |_ctx, req, responder| {
                // En otro hilo, y esto **no** es una optimización.
                //
                // La primera versión era síncrona, con el argumento de que aquí
                // no hay red de por medio y sólo hay que comprimir algo que ya
                // está en memoria. Pero comprimir cuesta once milisegundos y el
                // manejador síncrono corre en el hilo que atiende al webview:
                // con la pantalla pidiendo tramas seguidas, la ventana deja de
                // responder y acaba muriendo. Pasó en la v1.6.38.
                std::thread::spawn(move || responder.respond(video_frames::servir(&req)));
            },
        )
        .register_asynchronous_uri_scheme_protocol(media::SCHEME, |ctx, req, responder| {
            use tauri::Manager;
            let state = ctx.app_handle().state::<media::Session>();
            let token = state.token.lock().ok().and_then(|t| t.as_ref().cloned());
            let base = state.base_url.lock().ok().and_then(|b| b.as_ref().cloned());
            tauri::async_runtime::spawn(async move {
                responder.respond(media::serve(token, base, req).await);
            });
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // Reads the clipboard from the OS instead of the webview. WebKitGTK
        // hands a pasted bitmap to the page as an <img> with no src — see
        // readClipboardImage() in the frontend for the whole story.
        .plugin(tauri_plugin_clipboard_manager::init())
        // WebKitGTK trae WebRTC apagado de fábrica: sin esto, en Linux
        // `getUserMedia` ni siquiera existe en `navigator.mediaDevices` y los
        // canales de voz mueren antes de pedir el micrófono. Windows (WebView2)
        // y macOS (WKWebView) no necesitan nada equivalente.
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.with_webview(|webview| {
                        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                        let inner = webview.inner();
                        if let Some(settings) = inner.settings() {
                            settings.set_enable_webrtc(true);
                            settings.set_enable_media_stream(true);
                        }
                        // WebKitGTK deniega todo permiso que el embebedor no
                        // conteste — sin esto, `getUserMedia` devuelve
                        // NotAllowedError sin preguntarle a nadie. Se concede
                        // micrófono/cámara sin diálogo propio porque este
                        // webview sólo carga cac (los enlaces externos se abren
                        // en el navegador del sistema), así que quien pide es
                        // siempre nuestra propia app; el permiso del sistema
                        // operativo sigue aplicando por encima. La pantalla no
                        // pasa por aquí: la pide el portal del escritorio con
                        // su propio selector.
                        inner.connect_permission_request(|_, req| {
                            use webkit2gtk::glib::object::Cast;
                            use webkit2gtk::{DeviceInfoPermissionRequest, UserMediaPermissionRequest};
                            if req.downcast_ref::<UserMediaPermissionRequest>().is_some()
                                || req.downcast_ref::<DeviceInfoPermissionRequest>().is_some()
                            {
                                req.allow();
                                return true;
                            }
                            false
                        });
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            update_swarm_manage_agent,
            deploy_swarm_manage_agent,
            set_github_token,
            delete_github_token,
            github_token_configured,
            load_github_token_from_1password,
            refresh_github_token_from_1password,
            get_op_reference,
            clear_op_reference,
            list_github_secrets,
            list_github_variables,
            set_github_secret,
            set_github_variable,
            delete_github_secret,
            delete_github_variable,
            compress_image,
            executable_path,
            get_server_ssh_key,
            set_server_ssh_key,
            list_agent_ssh_keys,
            list_ssh_agents,
            jwt_decode,
            generate_id,
            hash_text,
            hmac_sign,
            bcrypt_hash,
            bcrypt_verify,
            argon2_hash,
            argon2_verify,
            encode_decode,
            send_http_request,
            api_request,
            set_session,
            open_attachment,
            sse_connect,
            sse_disconnect,
            save_file,
            export_notes,
            op_item_create,
            op_list_vaults,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            voice::voice_join,
            voice::voice_leave,
            voice::voice_set_mic,
            voice::voice_set_deaf,
            voice::voice_set_camera,
            voice::voice_list_devices,
            voice::voice_set_device,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


#[cfg(test)]
mod agent_tests {
    use super::parse_identity_agent;

    #[test]
    fn picks_the_active_line_and_ignores_commented_ones() {
        // Shape taken from a real config: two disabled variants around the live one.
        let cfg = "\
Host *
  #  IdentityAgent ~/.bitwarden-ssh-agent.sock
  IdentityAgent /home/rv/.1password/agent.sock
  #IdentityAgent none
";
        assert_eq!(
            parse_identity_agent(cfg).as_deref(),
            Some("/home/rv/.1password/agent.sock")
        );
    }

    #[test]
    fn handles_equals_quotes_and_case() {
        let cfg = "IdentityAgent=\"~/.1password/agent.sock\"\n";
        assert_eq!(parse_identity_agent(cfg).as_deref(), Some("~/.1password/agent.sock"));
        let cfg = "  identityagent   /tmp/a.sock\n";
        assert_eq!(parse_identity_agent(cfg).as_deref(), Some("/tmp/a.sock"));
    }

    #[test]
    fn none_and_lookalikes_are_not_sockets() {
        // `IdentityAgent none` disables the agent — following it would be wrong.
        assert_eq!(parse_identity_agent("IdentityAgent none\n"), None);
        // A different keyword that merely starts the same way.
        assert_eq!(parse_identity_agent("IdentityAgentFoo /x\n"), None);
        assert_eq!(parse_identity_agent("IdentityFile ~/.ssh/id_ed25519\n"), None);
    }
}