mod crypto_tools;
mod http_client;
mod image;

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
fn ssh_run(host: &str, port: u16, user: &str, remote_cmd: &str) -> Result<SshOutput, String> {
    use std::process::Command;

    let target = format!("{user}@{host}");
    let port_str = port.to_string();

    let output = Command::new("ssh")
        .args([
            "-p",
            &port_str,
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=15",
            &target,
            remote_cmd,
        ])
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
        let hint = if trimmed.contains("Permission denied") {
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
) -> Result<SshOutput, String> {
    let service_name = service.unwrap_or_else(|| "cac_swarm-manage".to_string());
    let remote = format!(
        "docker service update --force --image {AGENT_IMAGE} {service_name}"
    );
    ssh_run(&host, ssh_port, &ssh_user, &remote)
}

#[tauri::command]
fn deploy_swarm_manage_agent(
    host: String,
    ssh_port: u16,
    ssh_user: String,
    agent_port: u16,
    stack: Option<String>,
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
    ssh_run(&host, ssh_port, &ssh_user, &remote)
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

// ─── HTTP client ─────────────────────────────────────────────────────────────

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

// ─── App entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TokenCache(Mutex::new(HashMap::new())))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            save_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
