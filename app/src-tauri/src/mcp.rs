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

/// Marca de origen: dice que esto lo escribió el agente y no la persona.
///
/// Va en cada llamada a cac —también en las lecturas, para que el servidor vea
/// una petición coherente— y su único trabajo es que la campana pueda etiquetar
/// lo que hizo un agente.
///
/// **No es una credencial ni una barrera.** Este servidor usa el token de su
/// dueño, así que una petición suya ya puede hacer todo lo que él puede; la
/// cabecera es una declaración voluntaria, y quien tenga el token puede
/// omitirla. Sirve para ser honesto con quien lee, no para impedir nada.
const VIA_HEADER: &str = "X-Cac-Via";
const VIA_MCP: &str = "mcp";

fn cfg() -> Result<Cfg, String> {
    let base = std::env::var("CAC_URL")
        .unwrap_or_else(|_| "https://cac.guz-studio.dev".to_string())
        .trim_end_matches('/')
        .to_string();
    let token = std::env::var("CAC_TOKEN").map_err(|_| {
        "CAC_TOKEN is not set (create one in cac → Connect Claude Code)".to_string()
    })?;
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
            .header(VIA_HEADER, VIA_MCP)
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

fn api_put(cfg: &Cfg, path: &str, body: Value) -> Result<Value, String> {
    api_write(cfg, "PUT", path, body)
}

/// Multipart write, for the endpoints that accept files. Comments take
/// multipart even when they carry only text — one format for the whole family,
/// rather than JSON here and multipart there depending on attachments.
fn api_form(
    cfg: &Cfg,
    method: &str,
    path: &str,
    fields: Vec<(&str, String)>,
) -> Result<Value, String> {
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
        let mut form = reqwest::multipart::Form::new();
        for (k, v) in fields {
            form = form.text(k.to_string(), v);
        }
        let req = match method {
            "PATCH" => client.patch(&url),
            _ => client.post(&url),
        };
        let res = req
            .header("Authorization", format!("Bearer {}", cfg.token))
            .header(VIA_HEADER, VIA_MCP)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| format!("bad response from cac: {e}"))?;
        if !status.is_success() {
            // Un choque de versiones no es un fallo del que haya que informar en
            // prosa: es la respuesta, y trae dentro lo que hace falta para
            // resolverlo. Convertirlo en texto obligaría a quien llama a volver a
            // pedir el documento, y en ese viaje puede cambiar otra vez.
            //
            // Por el **código**, no por el 409 a secas. Mirando sólo el estado,
            // esta rama se tragaba cualquier otro 409 —mover una tarjeta por una
            // ruta que la máquina de estados no permite, por ejemplo— y lo
            // devolvía como si hubiera ido bien: quien llamara veía «hecho» y no
            // había pasado nada. Un fallo que se anuncia como éxito es peor que
            // el fallo.
            if status.as_u16() == 409
                && matches!(
                    body.get("error").and_then(|v| v.as_str()),
                    Some("doc-conflict") | Some("doc-page-conflict")
                )
            {
                return Ok(json!({
                    "conflict": true,
                    "reason": "Someone saved this section after you read it. \
                               Merge your text into the `doc` below and send the \
                               new `bodyHash` — writing over it would delete what they wrote.",
                    "doc": body.get("data").cloned().unwrap_or(Value::Null),
                }));
            }
            return Err(explain_write_failure(status, &body));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    })
}

/// Downloads a file, returning its bytes and content type.
fn fetch_bytes(url: &str) -> Result<(Vec<u8>, String), String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("could not fetch {url}: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("could not fetch {url}: {}", res.status()));
        }
        let ctype = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = res.bytes().await.map_err(|e| e.to_string())?;
        Ok((bytes.to_vec(), ctype))
    })
}

/// Multipart upload of one file under the field name cac expects.
fn api_upload(
    cfg: &Cfg,
    path: &str,
    file_name: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> Result<Value, String> {
    let url = format!("{}{}", cfg.base, path);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name.to_string())
            .mime_str(content_type)
            .map_err(|e| e.to_string())?;
        let res = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", cfg.token))
            .header(VIA_HEADER, VIA_MCP)
            .multipart(reqwest::multipart::Form::new().part("file", part))
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| format!("bad response from cac: {e}"))?;
        if !status.is_success() {
            // Un choque de versiones no es un fallo del que haya que informar en
            // prosa: es la respuesta, y trae dentro lo que hace falta para
            // resolverlo. Convertirlo en texto obligaría a quien llama a volver a
            // pedir el documento, y en ese viaje puede cambiar otra vez.
            //
            // Por el **código**, no por el 409 a secas. Mirando sólo el estado,
            // esta rama se tragaba cualquier otro 409 —mover una tarjeta por una
            // ruta que la máquina de estados no permite, por ejemplo— y lo
            // devolvía como si hubiera ido bien: quien llamara veía «hecho» y no
            // había pasado nada. Un fallo que se anuncia como éxito es peor que
            // el fallo.
            if status.as_u16() == 409
                && matches!(
                    body.get("error").and_then(|v| v.as_str()),
                    Some("doc-conflict") | Some("doc-page-conflict")
                )
            {
                return Ok(json!({
                    "conflict": true,
                    "reason": "Someone saved this section after you read it. \
                               Merge your text into the `doc` below and send the \
                               new `bodyHash` — writing over it would delete what they wrote.",
                    "doc": body.get("data").cloned().unwrap_or(Value::Null),
                }));
            }
            return Err(explain_write_failure(status, &body));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    })
}

fn api_delete(cfg: &Cfg, path: &str) -> Result<Value, String> {
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
            .delete(&url)
            .header("Authorization", format!("Bearer {}", cfg.token))
            .header(VIA_HEADER, VIA_MCP)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| format!("bad response from cac: {e}"))?;
        if !status.is_success() {
            // Un choque de versiones no es un fallo del que haya que informar en
            // prosa: es la respuesta, y trae dentro lo que hace falta para
            // resolverlo. Convertirlo en texto obligaría a quien llama a volver a
            // pedir el documento, y en ese viaje puede cambiar otra vez.
            //
            // Por el **código**, no por el 409 a secas. Mirando sólo el estado,
            // esta rama se tragaba cualquier otro 409 —mover una tarjeta por una
            // ruta que la máquina de estados no permite, por ejemplo— y lo
            // devolvía como si hubiera ido bien: quien llamara veía «hecho» y no
            // había pasado nada. Un fallo que se anuncia como éxito es peor que
            // el fallo.
            if status.as_u16() == 409
                && matches!(
                    body.get("error").and_then(|v| v.as_str()),
                    Some("doc-conflict") | Some("doc-page-conflict")
                )
            {
                return Ok(json!({
                    "conflict": true,
                    "reason": "Someone saved this section after you read it. \
                               Merge your text into the `doc` below and send the \
                               new `bodyHash` — writing over it would delete what they wrote.",
                    "doc": body.get("data").cloned().unwrap_or(Value::Null),
                }));
            }
            return Err(explain_write_failure(status, &body));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    })
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
            "PUT" => client.put(&url),
            _ => client.post(&url),
        };
        let res = req
            .header("Authorization", format!("Bearer {}", cfg.token))
            .header(VIA_HEADER, VIA_MCP)
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
            // Un choque de versiones no es un fallo del que haya que informar en
            // prosa: es la respuesta, y trae dentro lo que hace falta para
            // resolverlo. Convertirlo en texto obligaría a quien llama a volver a
            // pedir el documento, y en ese viaje puede cambiar otra vez.
            //
            // Por el **código**, no por el 409 a secas. Mirando sólo el estado,
            // esta rama se tragaba cualquier otro 409 —mover una tarjeta por una
            // ruta que la máquina de estados no permite, por ejemplo— y lo
            // devolvía como si hubiera ido bien: quien llamara veía «hecho» y no
            // había pasado nada. Un fallo que se anuncia como éxito es peor que
            // el fallo.
            if status.as_u16() == 409
                && matches!(
                    body.get("error").and_then(|v| v.as_str()),
                    Some("doc-conflict") | Some("doc-page-conflict")
                )
            {
                return Ok(json!({
                    "conflict": true,
                    "reason": "Someone saved this section after you read it. \
                               Merge your text into the `doc` below and send the \
                               new `bodyHash` — writing over it would delete what they wrote.",
                    "doc": body.get("data").cloned().unwrap_or(Value::Null),
                }));
            }
            // «¿En cuál?» de notify_me: la respuesta trae las organizaciones,
            // y con ellas el agente lo arregla sin otra consulta.
            if status.as_u16() == 409 && body.get("error").and_then(|v| v.as_str()) == Some("pick-an-org") {
                return Ok(json!({
                    "sent": false,
                    "reason": "This person belongs to several organizations: call again with orgId set to one of these.",
                    "organizations": body.get("data").cloned().unwrap_or(Value::Null),
                }));
            }
            return Err(explain_write_failure(status, &body));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    })
}

/// Turns a refused write into something the caller can act on. Shared by all
/// three transports so a multipart write doesn't explain itself worse than a
/// JSON one.
fn explain_write_failure(status: reqwest::StatusCode, body: &Value) -> String {
    let msg = body
        .get("error")
        .and_then(|v| v.as_str())
        .or_else(|| body.get("message").and_then(|v| v.as_str()))
        .unwrap_or("request failed");
    // The backend answers `missing-scope:<name>`; turn that into the exact
    // remedy instead of making the caller guess.
    if let Some(scope) = msg.strip_prefix("missing-scope:") {
        return format!(
            "This token is valid but lacks the `{scope}` scope. In cac open Connect Claude Code, \
             mint a token with that permission checked, and replace CAC_TOKEN."
        );
    }
    match status.as_u16() {
        403 => format!("cac refused the write: {msg}"),
        401 => format!(
            "cac rejected the token itself ({msg}) — this is authentication, not a missing \
             permission. Check CAC_TOKEN is the current one and hasn't expired."
        ),
        _ => format!("cac returned {status}: {msg}"),
    }
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

/// El nodo del que cuelga un documento, validado antes de construir una ruta.
///
/// El `kind` se comprueba contra los tres que existen en vez de interpolarlo: un
/// valor inventado saldría de aquí metido en una URL, y lo que contesta el
/// servidor a una ruta que no existe no le dice a nadie qué escribió mal.
fn doc_target(args: &Value) -> Result<(String, String), String> {
    let kind = arg_str(args, "kind").ok_or("kind is required (space, folder or list)")?;
    if !matches!(kind.as_str(), "space" | "folder" | "list") {
        return Err(format!("unknown kind `{kind}`: use space, folder or list"));
    }
    let id = arg_str(args, "ownerId").ok_or("ownerId is required")?;
    Ok((kind, urlencode(&id)))
}

/// Igual con la sección: son cuatro y fijas.
fn doc_tab(args: &Value) -> Result<String, String> {
    let tab = arg_str(args, "tab").ok_or("tab is required")?;
    if !matches!(tab.as_str(), "overview" | "runbook" | "decisions" | "links") {
        return Err(format!(
            "unknown section `{tab}`: use overview, runbook, decisions or links"
        ));
    }
    Ok(tab)
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

/// Una lista de nombres, venga como array o como una sola cadena.
fn arg_names(args: &Value, key: &str) -> Option<Vec<String>> {
    match args.get(key)? {
        Value::Array(a) => Some(
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        ),
        Value::String(s) if !s.trim().is_empty() => Some(vec![s.trim().to_string()]),
        _ => None,
    }
}

/// Un vencimiento, de `YYYY-MM-DD` al instante que guarda el servidor.
///
/// `dueAt` es **una fecha, no un instante**, y se guarda como el día a
/// medianoche UTC —igual que lo manda la app—. Por eso aquí se pide la fecha y
/// no un RFC3339: un agente al oeste de Greenwich que mandara «el 30 a
/// medianoche» en su hora guardaría el 30 a las 06:00 UTC, que al leerlo es el
/// 30, sí, pero uno a las 23:00 del 29 en su hora guardaría el 29. Pedir la
/// fecha quita la zona de en medio. Ver `CLAUDE.md` («dueAt es una fecha
/// guardada como instante»).
fn due_date_to_instant(s: &str) -> Result<String, String> {
    let bad = || format!("dueAt must be a date, YYYY-MM-DD; got \"{s}\"");
    let p: Vec<&str> = s.trim().split('-').collect();
    if p.len() != 3 || p[0].len() != 4 || p[1].len() != 2 || p[2].len() != 2 {
        return Err(bad());
    }
    let y: u32 = p[0].parse().map_err(|_| bad())?;
    let m: u32 = p[1].parse().map_err(|_| bad())?;
    let d: u32 = p[2].parse().map_err(|_| bad())?;
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let max = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err(bad()),
    };
    if d == 0 || d > max {
        return Err(bad());
    }
    Ok(format!("{y:04}-{m:02}-{d:02}T00:00:00Z"))
}

/// Nombres a ids, contra lo que de verdad existe. Sin coincidencias parciales.
///
/// Un nombre que no está es un error **que dice cuáles sí**: dejarlo caer en
/// silencio es la cicatriz de este fichero —un argumento aceptado y perdido por
/// el camino—, y adivinar el más parecido pondría la etiqueta o la persona
/// equivocada sin que nadie lo notara. Sin distinguir mayúsculas, que es como
/// las escribe cualquiera.
fn resolve_names(
    wanted: &[String],
    available: &[(String, String)],
    what: &str,
) -> Result<Vec<String>, String> {
    let mut ids = Vec::with_capacity(wanted.len());
    let mut missing = vec![];
    for w in wanted {
        match available
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(w))
        {
            Some((_, id)) => {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
            None => missing.push(w.clone()),
        }
    }
    if !missing.is_empty() {
        let mut names: Vec<&str> = available.iter().map(|(n, _)| n.as_str()).collect();
        names.sort_unstable();
        return Err(format!(
            "No such {what}: \"{}\". Available: {}",
            missing.join("\", \""),
            if names.is_empty() {
                "none".into()
            } else {
                names.join(", ")
            }
        ));
    }
    Ok(ids)
}

/// De qué organización es una lista, buscándola en el árbol de espacios.
///
/// Hace falta **antes** de crear una tarea con etiquetas o responsables: se
/// resuelven contra la organización, y un nombre que no existe tiene que fallar
/// antes de crear nada, no dejar una tarea a medias.
fn org_of_list(spaces: &Value, list_id: &str) -> Option<String> {
    fn has(lists: Option<&Value>, id: &str) -> bool {
        lists
            .and_then(|l| l.as_array())
            .map(|a| {
                a.iter()
                    .any(|l| l.get("id").and_then(|v| v.as_str()) == Some(id))
            })
            .unwrap_or(false)
    }
    fn in_folders(folders: Option<&Value>, id: &str) -> bool {
        folders.and_then(|f| f.as_array()).map_or(false, |a| {
            a.iter()
                .any(|f| has(f.get("lists"), id) || in_folders(f.get("folders"), id))
        })
    }
    spaces.as_array()?.iter().find_map(|sp| {
        if has(sp.get("lists"), list_id) || in_folders(sp.get("folders"), list_id) {
            sp.get("orgId").and_then(|v| v.as_str()).map(String::from)
        } else {
            None
        }
    })
}

/// La consulta de `search`, validada.
///
/// El servidor calla en dos casos que un agente leería mal: con menos de dos
/// caracteres devuelve vacío sin error —que se lee como «no hay nada»—, y un
/// límite por encima de 20 no se recorta a 20, vuelve a 8. Aquí los dos se
/// dicen o se corrigen.
fn search_query(args: &Value) -> Result<String, String> {
    let q = arg_str(args, "query").ok_or("query is required")?;
    if q.trim().chars().count() < 2 {
        return Err("query needs at least 2 characters".into());
    }
    let mut parts = vec![format!("q={}", urlencode(q.trim()))];
    push_q(&mut parts, "orgId", arg_str(args, "orgId"));
    if let Some(l) = arg_i64(args, "limit") {
        parts.push(format!("limit={}", l.clamp(1, 20)));
    }
    Ok(qs(parts))
}

/// Lo que `search` devuelve: tareas, notas y docs, y nada del chat.
///
/// El servidor también busca mensajes de canal, directos y personas, pero el
/// MCP no tiene ninguna herramienta de chat. Sacarlos por aquí le abriría a un
/// agente —con quién hablaste de qué— algo que nadie ha decidido darle.
fn search_results(data: &Value) -> Value {
    json!({
        "tasks": data.get("tasks"),
        "notes": data.get("notes"),
        "docs": data.get("docs"),
    })
}

// ─── Documentos por sección (#85, #86) ───────────────────────────────────────
//
// Un doc entero son decenas de miles de caracteres —el runbook de un proyecto
// pasó de 57 000— y cada herramienta devolvía el documento completo, así que
// cada llamada rebasaba lo que un agente puede leer de una vez. Y para corregir
// un párrafo sólo había dos opciones: reescribir la pestaña entera o añadir al
// final, que es por lo que una sección vieja quedaba al lado de la nueva en vez
// de corregirse.
//
// Todo esto vive aquí y no en el backend a propósito: la pantalla del doc usa
// esas mismas rutas y necesita el documento entero. El recorte es de quien lo
// lee a través del MCP.

fn sha256_hex(s: &str) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Una sección de un markdown: de su título hasta el siguiente título del mismo
/// nivel o superior. Offsets en bytes sobre el cuerpo.
#[derive(Debug, Clone, PartialEq)]
struct Section {
    heading: String,
    level: usize,
    start: usize,
    /// Donde empieza lo que va debajo del título.
    content_start: usize,
    end: usize,
}

/// Las secciones de un markdown, sin contar los `#` de dentro de un bloque de
/// código: un `# comentario` en un bloque de bash no es un título, y tomarlo
/// por uno partiría el runbook por la mitad de un comando.
fn sections(body: &str) -> Vec<Section> {
    let mut heads: Vec<(usize, usize, usize, String)> = vec![]; // start, content_start, level, text
    let mut fence: Option<&str> = None;
    let mut pos = 0;
    for line in body.split_inclusive('\n') {
        let t = line.trim_start();
        let marker = if t.starts_with("```") {
            Some("```")
        } else if t.starts_with("~~~") {
            Some("~~~")
        } else {
            None
        };
        match (fence, marker) {
            (None, Some(m)) => fence = Some(m),
            (Some(open), Some(m)) if open == m => fence = None,
            _ => {}
        }
        if fence.is_none() && marker.is_none() {
            let hashes = line.bytes().take_while(|b| *b == b'#').count();
            if (1..=6).contains(&hashes) && line[hashes..].starts_with(' ') {
                let text = line[hashes..]
                    .trim()
                    .trim_end_matches('#')
                    .trim()
                    .to_string();
                heads.push((pos, pos + line.len(), hashes, text));
            }
        }
        pos += line.len();
    }
    heads
        .iter()
        .enumerate()
        .map(|(i, (start, content_start, level, text))| {
            let end = heads[i + 1..]
                .iter()
                .find(|(_, _, l, _)| l <= level)
                .map(|(s, _, _, _)| *s)
                .unwrap_or(body.len());
            Section {
                heading: text.clone(),
                level: *level,
                start: *start,
                content_start: *content_start,
                end,
            }
        })
        .collect()
}

/// La sección que se pide, por su título. Con o sin los `#`, sin distinguir
/// mayúsculas. Un título que no está, o que está dos veces, es un error que dice
/// cuáles hay: adivinar cuál de dos «## Correo» se quería reescribir borraría la
/// equivocada.
fn find_section(body: &str, wanted: &str) -> Result<Section, String> {
    let w = wanted.trim().trim_start_matches('#').trim();
    let all = sections(body);
    let hits: Vec<&Section> = all
        .iter()
        .filter(|s| s.heading.eq_ignore_ascii_case(w))
        .collect();
    match hits.len() {
        1 => Ok(hits[0].clone()),
        0 => Err(format!(
            "No section titled \"{w}\". Sections here: {}",
            if all.is_empty() {
                "none — this tab has no headings".to_string()
            } else {
                all.iter().map(|s| format!("{} {}", "#".repeat(s.level), s.heading)).collect::<Vec<_>>().join(" | ")
            }
        )),
        n => Err(format!(
            "\"{w}\" is the title of {n} sections, so it doesn't say which one. Rename one of them first."
        )),
    }
}

/// El hash de una sección: de su título al final, tal cual está.
fn section_hash(body: &str, s: &Section) -> String {
    sha256_hex(&body[s.start..s.end])
}

/// El índice de una pestaña: sus títulos, con el hash que pide
/// `write_doc_section` para reescribir cada uno.
fn tab_outline(body: &str) -> Value {
    json!(sections(body)
        .iter()
        .map(|s| json!({ "heading": s.heading, "level": s.level, "sectionHash": section_hash(body, s) }))
        .collect::<Vec<_>>())
}

/// Reemplaza lo que hay debajo del título de una sección. El título se queda.
///
/// Con una línea en blanco debajo del título, como se escriben aquí, y otra
/// antes de lo que sigue, para que el título siguiente no quede pegado al
/// último párrafo y deje de leerse como título.
fn splice_section(body: &str, s: &Section, content: &str) -> String {
    let mut middle = format!("\n{}\n", content.trim_matches('\n'));
    if s.end < body.len() {
        middle.push('\n');
    }
    format!("{}{}{}", &body[..s.content_start], middle, &body[s.end..])
}

fn doc_tab_of<'a>(doc: &'a Value, key: &str) -> Option<&'a Value> {
    doc.get("tabs")?
        .as_array()?
        .iter()
        .find(|t| t.get("key").and_then(|k| k.as_str()) == Some(key))
}

fn tab_body(tab: &Value) -> &str {
    tab.get("body").and_then(|b| b.as_str()).unwrap_or("")
}

/// Lo que devuelve una escritura: con qué seguir, y no el documento entero.
///
/// Antes era `completa(doc)`: las cuatro pestañas con sus cuerpos y el registro
/// entero de decisiones, decenas de miles de caracteres para contestar «hecho».
fn short_tab_write(doc: &Value, key: &str) -> Value {
    match doc_tab_of(doc, key) {
        Some(t) => json!({
            "tab": key,
            "bodyHash": t.get("bodyHash"),
            "updatedAt": t.get("updatedAt"),
            "chars": tab_body(t).chars().count(),
        }),
        None => json!({ "tab": key }),
    }
}

/// Un conflicto de escritura, con sólo la pestaña en conflicto: es lo único que
/// hace falta para fusionar y volver a mandar.
fn short_conflict(result: &Value, key: &str) -> Option<Value> {
    if result.get("conflict").and_then(|c| c.as_bool()) != Some(true) {
        return None;
    }
    let doc = result.get("doc").cloned().unwrap_or(Value::Null);
    let tab = doc_tab_of(&doc, key);
    Some(json!({
        "conflict": true,
        "reason": result.get("reason"),
        "tab": key,
        "bodyHash": tab.and_then(|t| t.get("bodyHash")),
        "body": tab.map(tab_body),
    }))
}

/// `get_doc` sin pestaña: el índice del documento.
///
/// Qué hay y dónde, sin los cuerpos. `doc.body` fuera siempre: es el markdown de
/// antes de las pestañas, y en los docs migrados repetía el overview entero.
/// Del registro de decisiones, los títulos, que es con lo que se decide cuál
/// abrir.
fn doc_outline(doc: &Value) -> Value {
    let mut meta = doc.get("doc").cloned().unwrap_or(Value::Null);
    if let Some(o) = meta.as_object_mut() {
        o.remove("body");
    }
    let tabs: Vec<Value> = doc
        .get("tabs")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .map(|t| {
                    let body = tab_body(t);
                    json!({
                        "key": t.get("key"),
                        "bodyHash": t.get("bodyHash"),
                        "chars": body.chars().count(),
                        "sections": tab_outline(body),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let decisions: Vec<Value> = doc
        .get("decisions")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .map(|d| json!({ "id": d.get("id"), "title": d.get("title"), "tag": d.get("tag"), "decidedAt": d.get("decidedAt") }))
                .collect()
        })
        .unwrap_or_default();
    json!({
        "doc": meta,
        "tabs": tabs,
        "decisions": decisions,
        "attachments": doc.get("attachments").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0),
        "note": "Read one section with get_doc + tab (and section, for one heading). Rewrite one heading with write_doc_section and its sectionHash.",
    })
}

// ─── Páginas de un documento ─────────────────────────────────────────────────
//
// Debajo de la portada de cada nodo (las cuatro pestañas) cuelga un árbol de
// páginas. Existe porque un doc con cuatro pestañas fijas obligaba a meterlo
// todo en una: en Proteus (dwit) la portada de «Apps» llegó a 133 000
// caracteres con cinco aplicaciones dentro.

/// Una página, validada antes de meterla en una ruta.
fn page_target(args: &Value) -> Result<(String, String, String), String> {
    let (kind, id) = doc_target(args)?;
    let page = arg_str(args, "pageId").ok_or("pageId is required: use list_doc_pages")?;
    Ok((kind, id, urlencode(&page)))
}

/// El enlace de la app a una página: lo que se pega en otra página o en un chat.
fn page_link(kind: &str, owner: &str, page: &str) -> String {
    format!("/tasks?doc={kind}:{owner}&page={page}")
}

/// El árbol plano que devuelve el backend, anidado y con el enlace de cada
/// página, para que el agente no tenga que reconstruir la jerarquía.
fn build_page_tree(flat: &Value, kind: &str, owner: &str) -> Value {
    let empty = vec![];
    let items = flat.as_array().unwrap_or(&empty);
    fn node(item: &Value, items: &[Value], kind: &str, owner: &str) -> Value {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let children: Vec<Value> = items
            .iter()
            .filter(|c| c.get("parentId").and_then(|v| v.as_str()) == Some(id))
            .map(|c| node(c, items, kind, owner))
            .collect();
        json!({
            "id": item.get("id"),
            "title": item.get("title"),
            "hasBody": item.get("hasBody"),
            "link": page_link(kind, owner, id),
            "children": children,
        })
    }
    let roots: Vec<Value> = items
        .iter()
        .filter(|i| i.get("parentId").map(|p| p.is_null()).unwrap_or(true))
        .map(|i| node(i, items, kind, owner))
        .collect();
    json!(roots)
}

/// Lo que el índice de un doc dice de sus páginas: cuántas y los títulos de las
/// primeras. Sin esto, un agente que lee la portada no sabe que hay árbol.
fn pages_summary(flat: &Value) -> Value {
    let empty = vec![];
    let items = flat.as_array().unwrap_or(&empty);
    let titles: Vec<Value> = items
        .iter()
        .take(20)
        .map(|i| i.get("title").cloned().unwrap_or(Value::Null))
        .collect();
    json!({
        "count": items.len(),
        "titles": titles,
        "note": "This document has subpages. List them with list_doc_pages.",
    })
}

fn page_body(view: &Value) -> &str {
    view.get("page")
        .and_then(|p| p.get("body"))
        .and_then(|b| b.as_str())
        .unwrap_or("")
}

/// `get_doc_page` sin sección: el índice de la página, sin el cuerpo.
/// Un .md del repo como lo lee un agente: su índice, una sección o entero,
/// igual que una página. Sin hashes: es de sólo lectura, no hay nada que
/// reescribir con ellos.
fn repo_doc_view(d: &Value, section: Option<&str>, full: bool) -> Result<Value, String> {
    let body = d.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let mut out = json!({
        "id": d.get("id"),
        "title": d.get("title"),
        "path": d.get("path"),
        "repo": d.get("fullName"),
        "branch": d.get("branch"),
        "htmlUrl": d.get("htmlUrl"),
        "syncedAt": d.get("syncedAt"),
        "readOnly": true,
    });
    // Quién lo cambió por última vez, si un push lo contó.
    if d.get("lastCommitSha").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()) {
        out["lastCommit"] = json!({
            "author": d.get("lastAuthor"),
            "at": d.get("lastCommitAt"),
            "message": d.get("lastMessage"),
            "url": d.get("commitUrl"),
        });
    }
    if d.get("tooLarge").and_then(|v| v.as_bool()).unwrap_or(false) {
        out["tooLarge"] = json!(true);
        return Ok(out);
    }
    if let Some(wanted) = section {
        let sec = find_section(body, wanted)?;
        out["section"] = json!(sec.heading);
        out["text"] = json!(&body[sec.start..sec.end]);
        return Ok(out);
    }
    out["headings"] = json!(sections(body)
        .iter()
        .map(|s| json!({ "heading": s.heading, "level": s.level }))
        .collect::<Vec<_>>());
    if full {
        out["body"] = json!(body);
    }
    Ok(out)
}

fn page_outline(view: &Value, kind: &str, owner: &str) -> Value {
    let page = view.get("page").cloned().unwrap_or(Value::Null);
    let body = page_body(view);
    let id = page.get("id").and_then(|v| v.as_str()).unwrap_or("");
    json!({
        "pageId": page.get("id"),
        "title": page.get("title"),
        "link": page_link(kind, owner, id),
        "breadcrumb": view.get("breadcrumb"),
        "bodyHash": page.get("bodyHash"),
        "chars": body.chars().count(),
        "sections": tab_outline(body),
        "children": view.get("children"),
        // Lo que enlaza aquí: antes de mover el contenido de una página, es lo
        // que dice qué enlaces hay que revisar.
        "referencedFrom": view.get("referencedFrom"),
        "updatedAt": page.get("updatedAt"),
        "updatedByName": page.get("updatedByName"),
        "note": "Read one section with get_doc_page + section, or the whole body with full=true. Rewrite one heading with write_doc_page_section and its sectionHash.",
    })
}

/// Lo que devuelve una escritura en una página: con qué seguir.
fn short_page_write(page: &Value, kind: &str, owner: &str) -> Value {
    let id = page.get("id").and_then(|v| v.as_str()).unwrap_or("");
    json!({
        "pageId": page.get("id"),
        "title": page.get("title"),
        "bodyHash": page.get("bodyHash"),
        "chars": page.get("body").and_then(|b| b.as_str()).map(|b| b.chars().count()),
        "link": page_link(kind, owner, id),
    })
}

/// Un conflicto al guardar una página, con su texto actual para fundir.
fn short_page_conflict(result: &Value) -> Option<Value> {
    if result.get("conflict").and_then(|c| c.as_bool()) != Some(true) {
        return None;
    }
    let page = result.get("doc").cloned().unwrap_or(Value::Null);
    Some(json!({
        "conflict": true,
        "reason": result.get("reason"),
        "pageId": page.get("id"),
        "bodyHash": page.get("bodyHash"),
        "body": page.get("body"),
    }))
}

/// Reescribe lo que hay debajo de un título de una página. La misma lógica que
/// `write_section` —el hash de la sección dice que lo leído sigue igual; el de la
/// página, que nadie guardó en medio—, con las rutas de la página.
fn write_page_section(
    cfg: &Cfg,
    kind: &str,
    id: &str,
    page: &str,
    wanted: &str,
    expected: &str,
    content: &str,
) -> Result<Value, String> {
    let path = format!("/api/v1/docs/{kind}/{id}/pages/{page}");
    for _ in 0..2 {
        let view = api_get(cfg, &path)?;
        let body = page_body(&view).to_string();
        let (sec, new_body) = match plan_section_write(&body, "page", wanted, expected, content)? {
            Ok(plan) => plan,
            Err(conflict) => return Ok(conflict),
        };
        let mut req = json!({ "body": new_body });
        if let Some(h) = view
            .get("page")
            .and_then(|p| p.get("bodyHash"))
            .and_then(|v| v.as_str())
            .filter(|h| !h.is_empty())
        {
            req["baseHash"] = json!(h);
        }
        let out = api_put(cfg, &path, req)?;
        if short_page_conflict(&out).is_some() {
            continue;
        }
        let nb = out.get("body").and_then(|b| b.as_str()).unwrap_or("");
        return Ok(json!({
            "pageId": out.get("id"),
            "section": sec.heading,
            "sectionHash": find_section(nb, wanted).ok().map(|s| section_hash(nb, &s)),
            "bodyHash": out.get("bodyHash"),
        }));
    }
    Err("The page kept changing while writing this section. Read it again with get_doc_page and retry.".into())
}

/// La decisión que se acaba de apuntar, y no el documento entero.
///
/// El backend contesta con el documento completo; la entrada nueva es la de
/// `createdAt` más reciente —no la primera de la lista, que va por `decidedAt` y
/// una decisión de la semana pasada apuntada hoy quedaría abajo—.
fn recorded_decision(doc: &Value) -> Value {
    let newest = doc
        .get("decisions")
        .and_then(|d| d.as_array())
        .and_then(|a| {
            a.iter().max_by_key(|d| {
                d.get("createdAt")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string()
            })
        });
    match newest {
        Some(d) => json!({
            "recorded": true,
            "id": d.get("id"),
            "title": d.get("title"),
            "origin": d.get("origin"),
            "originTaskId": d.get("originTaskId"),
            "decidedAt": d.get("decidedAt"),
        }),
        None => json!({ "recorded": true }),
    }
}

/// Qué hacer con una escritura de sección, sin red de por medio: o el cuerpo
/// nuevo de la pestaña, o el conflicto que hay que devolver.
///
/// Aparte de `write_section` para poder probarse: es la mitad que decide si se
/// pisa o no lo que escribió otro, y eso no puede depender de montar un
/// servidor para comprobarlo.
fn plan_section_write(
    body: &str,
    tab: &str,
    wanted: &str,
    expected: &str,
    content: &str,
) -> Result<Result<(Section, String), Value>, String> {
    let sec = find_section(body, wanted)?;
    let current = section_hash(body, &sec);
    if current != expected {
        return Ok(Err(json!({
            "conflict": true,
            "reason": "This section changed since you read it. Merge your text into `text` below and send the new sectionHash — writing over it would delete what someone else wrote.",
            "tab": tab,
            "section": sec.heading,
            "sectionHash": current,
            "text": &body[sec.start..sec.end],
        })));
    }
    let new_body = splice_section(body, &sec, content);
    Ok(Ok((sec, new_body)))
}

/// Reescribe lo que hay debajo de un título, con el hash propio de esa sección.
///
/// Dos hashes y no uno. El de la **sección** dice que lo que el agente leyó
/// sigue igual; el de la **pestaña** —el que ya existía— dice que nadie guardó
/// entre esta lectura y esta escritura. Si choca sólo el de la pestaña, alguien
/// tocó otra parte del runbook: la sección pedida sigue intacta, así que se
/// vuelve a leer y se reintenta una vez sobre lo nuevo. Si lo que cambió es la
/// sección, eso sí es un conflicto, y vuelve con su texto actual para fusionar.
fn write_section(
    cfg: &Cfg,
    kind: &str,
    id: &str,
    tab: &str,
    wanted: &str,
    expected: &str,
    content: &str,
) -> Result<Value, String> {
    let path = format!("/api/v1/docs/{kind}/{id}");
    for _ in 0..2 {
        let doc = api_get(cfg, &path)?;
        let t = doc_tab_of(&doc, tab).ok_or_else(|| format!("No tab \"{tab}\""))?;
        let body = tab_body(t).to_string();
        let (sec, new_body) = match plan_section_write(&body, tab, wanted, expected, content)? {
            Ok(plan) => plan,
            Err(conflict) => return Ok(conflict),
        };
        let mut req = json!({ "body": new_body });
        if let Some(h) = t
            .get("bodyHash")
            .and_then(|v| v.as_str())
            .filter(|h| !h.is_empty())
        {
            req["baseHash"] = json!(h);
        }
        let out = api_put(cfg, &format!("{path}/tabs/{tab}"), req)?;
        if short_conflict(&out, tab).is_some() {
            continue;
        }
        let after = doc_tab_of(&out, tab);
        let nb = after.map(tab_body).unwrap_or("");
        return Ok(json!({
            "tab": tab,
            "section": sec.heading,
            "sectionHash": find_section(nb, wanted).ok().map(|s| section_hash(nb, &s)),
            "bodyHash": after.and_then(|t| t.get("bodyHash")),
            "updatedAt": after.and_then(|t| t.get("updatedAt")),
        }));
    }
    Err(
        "The tab kept changing while writing this section. Read it again with get_doc and retry."
            .into(),
    )
}

/// El cuerpo de `record_decision`.
///
/// Por defecto la decisión viene «del documento». Con `originTaskId`, viene de
/// esa tarea y lleva el enlace de vuelta. Hasta el 28-sep-2026 esta herramienta
/// fijaba siempre «doc», y a propósito: el backend sólo comprobaba que el id no
/// viniera vacío, así que una decisión podía decir que venía de una tarea que
/// no existía, en un registro del que no se borra nada. Ahora el backend exige
/// que la tarea exista y sea de la misma organización (#91), y el enlace ya no
/// puede mentir.
fn decision_body(title: &str, args: &Value) -> Value {
    let mut body = json!({ "title": title, "origin": "doc" });
    for key in ["body", "tag", "decidedBy"] {
        if let Some(x) = arg_str(args, key) {
            body[key] = json!(x);
        }
    }
    if let Some(task) = arg_str(args, "originTaskId") {
        body["origin"] = json!("task");
        body["originTaskId"] = json!(task);
    }
    body
}

/// `(nombre, id)` de las etiquetas de una organización.
fn tag_pairs(data: &Value) -> Vec<(String, String)> {
    data.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    Some((
                        t.get("name")?.as_str()?.to_string(),
                        t.get("id")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `(username, userId)` de los miembros de una organización.
fn member_pairs(data: &Value) -> Vec<(String, String)> {
    data.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some((
                        m.get("username")?.as_str()?.to_string(),
                        m.get("userId")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Etiquetas, responsables y fechas de una tarea, ya resueltos a lo que espera
/// el backend. Lo usan crear y editar, para que las dos digan lo mismo.
fn resolve_task_extras(
    cfg: &Cfg,
    org_id: &str,
    args: &Value,
    body: &mut Value,
) -> Result<(), String> {
    if let Some(names) = arg_names(args, "tags") {
        let tags = api_get(
            cfg,
            &format!(
                "/api/v1/task-tags/{}",
                qs(vec![format!("orgId={}", urlencode(org_id))])
            ),
        )?;
        body["tagIds"] = json!(resolve_names(&names, &tag_pairs(&tags), "tag")?);
    }
    if let Some(names) = arg_names(args, "assignees") {
        let members = api_get(
            cfg,
            &format!("/api/v1/organizations/{}/members", urlencode(org_id)),
        )?;
        body["assigneeIds"] = json!(resolve_names(&names, &member_pairs(&members), "member")?);
    }
    // Sólo el vencimiento. `startAt` también existe en el backend, pero nada
    // dice que sea una fecha y no un instante, y convertirlo a medianoche UTC
    // a ciegas sería repetir con él el fallo que se arregló con `dueAt`.
    if let Some(d) = arg_str(args, "dueAt") {
        body["dueAt"] = json!(due_date_to_instant(&d)?);
    }
    // Quitarla es un campo aparte: un `dueAt` vacío o nulo el servidor lo lee
    // como «no tocar» (#95).
    if arg_bool(args, "clearDueAt") {
        body["clearDueAt"] = json!(true);
    }
    Ok(())
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
            "name": "add_report_comment",
            "description": "Reply to a bug report. Append-only: it cannot overwrite what anyone else wrote, and the reply is signed with the token owner's name — whoever filed the report sees it as an answer from the team. Needs `reports:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Report id, from list_reports." },
                    "body": { "type": "string", "description": "Markdown." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id", "body"]
            }
        },
        {
            "name": "edit_report_comment",
            "description": "Correct a comment you wrote. Only your own: cac refuses anyone else's, the reporter's and system notes. Replaces the text outright — there is no history. Needs `reports:manage`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Report id." },
                    "commentId": { "type": "string" },
                    "body": { "type": "string", "description": "The replacement text, markdown." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id", "commentId", "body"]
            }
        },
        {
            "name": "delete_report_comment",
            "description": "Withdraw a comment you wrote. It disappears for the reporter and for any tenant app, while staying visible inside cac marked as withdrawn — the team keeps the record. Only your own. Needs `reports:manage`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Report id." },
                    "commentId": { "type": "string" },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id", "commentId"]
            }
        },
        {
            "name": "update_report",
            "description": "Triage a report: status, priority, category, area or assignee. Status moves must follow the state machine — read GET /reports/transitions, or an illegal move answers 409. Needs `reports:manage`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "status": { "type": "string", "description": "open | in_progress | done | closed" },
                    "priority": { "type": "string", "description": "low | medium | high | urgent" },
                    "category": { "type": "string", "description": "bug | ui | performance | data | other" },
                    "area": { "type": "string", "description": "Free text, trimmed to 60 chars." },
                    "assigneeUserId": { "type": "string", "description": "A cac user in the report's org; \"\" unassigns." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "add_note_attachment",
            "description": "Attach a file to a note, from a URL (cac downloads it and keeps its own copy) or from a local `path`. Returns the markdown to paste into the body: an image for an image, a link for anything else (a PDF shows as a card in the app). Use it when migrating content in, so images stop being served by wherever they came from. A local path only accepts files that get attached — images, PDF, office documents, audio, video, zip, csv — never keys, .env, .json or text. Needs `notes:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id, from list_notes." },
                    "url": { "type": "string", "description": "Where to fetch the file from. Give this or `path`, not both." },
                    "path": { "type": "string", "description": "A file on this machine, absolute. Give this or `url`, not both." },
                    "fileName": { "type": "string", "description": "Name to store it under. Defaults to the file's own name." },
                    "dryRun": { "type": "boolean", "description": "Validate the note and the token's permission without reading or writing." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "add_task_attachment",
            "description": "Attach a file to a task — a screenshot, a log, a PDF — from a local `path` or a URL. It lands in the task's attachments, and the answer carries the markdown to show it inline: paste it into the description (update_task) or into a comment (add_task_comment). An image comes back as an image, anything else as a link (a PDF shows as a card in the app). Attachments of a task are never shown to a client. A local path only accepts files that get attached — images, PDF, office documents, audio, video, zip, csv — never keys, .env, .json or text. Needs `tasks:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Task id (from get_board, get_task or search)." },
                    "path": { "type": "string", "description": "A file on this machine, absolute. Give this or `url`, not both." },
                    "url": { "type": "string", "description": "Where to fetch the file from. Give this or `path`, not both." },
                    "fileName": { "type": "string", "description": "Name to store it under. Defaults to the file's own name." },
                    "dryRun": { "type": "boolean", "description": "Validate the task and the token's permission without reading or writing." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "list_servers",
            "description": "The servers cac manages (Docker Swarm or Kubernetes), with their id, name, type and status. Use it to find the serverId the deploy tools take.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_deployables",
            "description": "The services of a server that cac deploys (its \"deployables\"), with how each one deploys: image repo, GitHub repo, branch, whether it builds on the server, Dockerfile and build context, the CI workflow and what a CI notice does. Use it to find the deployableId.",
            "inputSchema": {
                "type": "object",
                "properties": { "serverId": { "type": "string" } },
                "required": ["serverId"]
            }
        },
        {
            "name": "list_backups",
            "description": "The databases of a server that cac backs up, with their schedule (every N hours from a time, in a time zone), retention, when the next backup runs, the last good one and the last restore test. Read-only: starting a backup or a restore test stays a person's decision in the app.",
            "inputSchema": {
                "type": "object",
                "properties": { "serverId": { "type": "string" } },
                "required": ["serverId"]
            }
        },
        {
            "name": "get_backup_history",
            "description": "The latest backups and restore tests of one database (from list_backups): status, size, retention class, until when it is kept, and the error if it failed. Backups are encrypted; nothing here opens them.",
            "inputSchema": {
                "type": "object",
                "properties": { "serverId": { "type": "string" }, "targetId": { "type": "string" }, "limit": { "type": "integer" } },
                "required": ["serverId", "targetId"]
            }
        },
        {
            "name": "get_deploy_config",
            "description": "Everything about how one service deploys, in one call: its configuration, its secrets BY NAME with where each value lives in 1Password (opRef) and whether it is used at runtime, at build time or both, and the build args its Dockerfile declares (to cross them with the secrets). Never returns a secret value.",
            "inputSchema": {
                "type": "object",
                "properties": { "serverId": { "type": "string" }, "deployableId": { "type": "string" } },
                "required": ["serverId", "deployableId"]
            }
        },
        {
            "name": "create_deployable",
            "description": "Register a service of the server as deployable by cac. Needs the `deploys:manage` scope (and an org admin behind the token). It does not deploy anything.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "name": { "type": "string", "description": "What cac calls it." },
                    "stack": { "type": "string", "description": "The Swarm stack it belongs to." },
                    "serviceName": { "type": "string", "description": "The Swarm service, e.g. stack_web." },
                    "imageRepo": { "type": "string", "description": "e.g. ghcr.io/org/app" },
                    "environment": { "type": "string" },
                    "repoFullName": { "type": "string", "description": "owner/repo on GitHub." },
                    "shortTags": { "type": "boolean" },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["serverId", "name", "stack", "serviceName", "imageRepo"]
            }
        },
        {
            "name": "update_deploy_config",
            "description": "Change how a service deploys. Only the fields you send are touched. Needs the `deploys:manage` scope (and an org admin behind the token). It never deploys, and it cannot change the migration command: that one runs on the server and stays a person's decision in the app.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "deployableId": { "type": "string" },
                    "name": { "type": "string" },
                    "environment": { "type": "string" },
                    "repoFullName": { "type": "string", "description": "owner/repo on GitHub." },
                    "onCINotify": { "type": "string", "enum": ["record", "deploy"], "description": "What a CI notice does: just record the build, or deploy it." },
                    "buildWorkflow": { "type": "string", "description": "The workflow file that builds the image, e.g. prod.yml." },
                    "shortTags": { "type": "boolean" },
                    "branch": { "type": "string", "description": "Only pushes/notices of this branch touch the service." },
                    "buildOnHost": { "type": "boolean", "description": "Build the image of each push on the server itself (agent v6+), without a registry." },
                    "dockerfile": { "type": "string", "description": "Path of the Dockerfile in the repo." },
                    "buildContext": { "type": "string", "description": "Folder the build runs from; empty is the repo root." },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["serverId", "deployableId"]
            }
        },
        {
            "name": "set_secret_refs",
            "description": "Set a service's secrets BY NAME: each one says where its value lives in 1Password (opRef, op://vault/item/field) and whether it is used at runtime, at build time or both. By default it merges by name: what you send is added or changed, the rest stays; `remove` takes names out, and `replace: true` makes the list exactly what you send. No secret value ever goes through cac: the app's \"Rotate on the server\" reads them from 1Password. Needs the `deploys:manage` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "deployableId": { "type": "string" },
                    "refs": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "UPPER_SNAKE_CASE, as the service reads it." },
                                "opRef": { "type": "string", "description": "op://vault/item/field" },
                                "usage": { "type": "string", "enum": ["runtime", "build", "both"] }
                            },
                            "required": ["name", "opRef"]
                        }
                    },
                    "remove": { "type": "array", "items": { "type": "string" } },
                    "replace": { "type": "boolean" },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["serverId", "deployableId"]
            }
        },
        {
            "name": "get_context",
            "description": "START HERE when you begin work in a repository. One call returns what the team knows about its project, without any bodies: the space's tree (folders and lists, with `path`; a list with `projectId` belongs to a client), for each node with a document the headings of its tabs (overview, runbook, decisions, links; up to level 3, with their size in `chars`), its subpages and its latest decisions, the markdown files of the repos linked to the space, and the tasks already in progress (so you don't duplicate one). `truncated` names anything cut for size.\n\nWith no arguments it reads the git remote of the folder you are working in and finds the space that GitHub repo is linked to. Then read only the sections you need: get_doc with kind, ownerId (the node's id), tab and section (a heading's text); get_doc_page for a subpage; get_repo_doc for a repo file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "spaceId": { "type": "string", "description": "Optional. The space, when you already know it." },
                    "repo": { "type": "string", "description": "Optional. owner/name of a GitHub repository, instead of reading the git remote." },
                    "path": { "type": "string", "description": "Optional. The folder whose git remote to read. Defaults to the folder this server was started in, which is the project Claude Code opened." }
                }
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
            "name": "search",
            "description": "Find tasks, notes and docs by text, instead of pulling whole boards. Returns what matched and where (kind, id, title, where, link), and a `snippet` with the matching words between ** where it is safe to show: a doc, a task's description (never a comment: it may be internal), a note. Each doc hit also carries its `ownerKind`/`ownerId`, and either the `tab` of the node's home or the `pageId` of a subpage, with `where` as the page's path, and `section`: the heading the match falls under. Read just that: get_doc with tab + section, get_doc_page or get_repo_doc with section — not the whole document. Open the other hits with get_task or get_note.\n\nEverything is full-text: words match by prefix and without accents, and titles rank first. Tasks match by title, description and comments; notes by title and body; docs by the home tabs and every page. Channel messages and direct messages are not searchable from here.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "At least 2 characters." },
                    "orgId": { "type": "string", "description": "Optional. Without it, the organizations you are a member of are searched and the hits merged; with it, only that one." },
                    "limit": { "type": "integer", "description": "Hits per kind, 1–20. Default 8." }
                },
                "required": ["query"]
            }
        },
        {
            "name": "get_task",
            "description": "Full detail of one task: its markdown description, status, priority, tags, assignees, attachments, the comment thread, its subtasks — which are its checklist — and `git`: the GitHub branches, pull requests (with state open/draft/merged/closed) and commits linked to it, by the task named in a commit/PR or by the branch name (cac-12-…, acme-7-…). get_board does not list subtasks; it only shows how many are done.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "create_task",
            "description": "Create a task in a list. Use list_task_spaces first to resolve the list name to its listId. Needs a token with the `tasks:write` scope.\n\nIf the list belongs to a client's channel (list_task_spaces shows a projectId on it), anything created there is VISIBLE TO THAT CLIENT by default: it lands on their board, takes a number from their folio sequence — permanently, even if withdrawn later — and fires their webhook. Pass visibility:\"internal\" to keep it to the team.\n\nA checklist inside a task is its SUBTASKS: pass them as `subtasks` in this same call (or create each line later with parentId), and tick each off with update_task + status: done. Don't keep pending items as text in comments — nobody can tell which ones are done.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "listId": { "type": "string", "description": "Target list (from list_task_spaces)." },
                    "title": { "type": "string" },
"subtasks": { "type": "array", "items": { "type": "string" }, "description": "Optional. The task's checklist, created in the same call as subtasks (titles, up to 30). Retrying with the same idempotencyKey finishes it without duplicates." },
                                        "parentId": {
                        "type": "string",
                        "description": "Optional. Makes this a subtask of that task. Two rules that surprise people: the parent must be in the SAME list — a subtask elsewhere would be unreachable from its parent's board — and a subtask of a client-visible item stays internal, so it never spends one of their folio numbers on a checklist line."
                    },
                    "description": { "type": "string", "description": "Optional markdown body." },
                    "priority": {
                        "type": "string",
                        "enum": ["none", "low", "normal", "high", "urgent"],
                        "description": "Optional; defaults to none."
                    },
                    "tags": {
                        "type": "array", "items": { "type": "string" },
                        "description": "Tag NAMES, not ids, from this organization. Replaces the whole set — read the task first to add one. An unknown name fails and lists the ones that exist; tokens cannot create new tags."
                    },
                    "assignees": {
                        "type": "array", "items": { "type": "string" },
                        "description": "Usernames of members of the task's organization. Replaces the whole set. An unknown one fails and lists who exists."
                    },
                    "dueAt": {
                        "type": "string",
                        "description": "Due DATE as YYYY-MM-DD — a day, not a time. Sent as that day at midnight UTC, which is how the app stores it; don't pass a local timestamp. To remove a due date, send clearDueAt: true instead."
                    },
                    "idempotencyKey": {
                        "type": "string",
                        "description": "Optional. Reusing the same key in the same list returns the task already created instead of a duplicate — send one if you might retry."
                    },
                    "visibility": {
                        "type": "string",
                        "enum": ["public", "internal"],
                        "description": "Only meaningful in a list bound to a client's channel. \"public\" (the default) puts it on their board and spends one of their folio numbers; \"internal\" keeps it to the team. In an unbound list everything is internal and this is ignored."
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
            "description": "Change an existing task: title, markdown description, priority, tags, assignees, due date, or which column it sits in (status by name: open, in_progress, done, closed). Needs a token with the `tasks:manage` scope — separate from creating, because this overwrites work someone else may have written. Only the fields you send are touched.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Task id (from get_board or get_task)." },
                    "title": { "type": "string" },
                    "description": { "type": "string", "description": "Markdown. Replaces the current body — read it with get_task first if you mean to add to it." },
                    "priority": { "type": "string", "enum": ["none", "low", "normal", "high", "urgent"] },
                    "tags": {
                        "type": "array", "items": { "type": "string" },
                        "description": "Tag NAMES, not ids, from this organization. Replaces the whole set — read the task first to add one. An unknown name fails and lists the ones that exist; tokens cannot create new tags."
                    },
                    "assignees": {
                        "type": "array", "items": { "type": "string" },
                        "description": "Usernames of members of the task's organization. Replaces the whole set. An unknown one fails and lists who exists."
                    },
                    "dueAt": {
                        "type": "string",
                        "description": "Due DATE as YYYY-MM-DD — a day, not a time. Sent as that day at midnight UTC, which is how the app stores it; don't pass a local timestamp. To remove a due date, send clearDueAt: true instead."
                    },
                    "clearDueAt": { "type": "boolean", "description": "Remove the task's due date." },
                    "status": { "type": "string", "enum": ["open", "in_progress", "done", "closed"], "description": "Move the task to the column of this state in its own list — no get_board needed. This is also how a subtask is ticked off (done)." },
                    "statusId": { "type": "string", "description": "Alternative to status: the exact column id from get_board." },
                    "visibility": {
                        "type": "string",
                        "enum": ["public", "internal"],
                        "description": "Show the item to the client whose channel this list belongs to, or take it back. Withdrawing does NOT return the folio number it was given — the client may already have quoted it, so their numbering keeps a gap. Publishing an internal item gives it the next number and notifies them."
                    },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "create_task_space",
            "description": "Create a space: the top of the task tree, one per project or area. Needs `tasks:write`. Deleting one is not available to a token at all.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "orgId": { "type": "string", "description": "Organization the space belongs to." },
                    "name": { "type": "string" },
                    "color": { "type": "string", "description": "Optional." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["orgId", "name"]
            }
        },
        {
            "name": "create_task_folder",
            "description": "Create a folder inside a space, to group its lists. Optional — a list can hang straight off the space. Needs `tasks:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "spaceId": { "type": "string", "description": "From list_task_spaces." },
                    "name": { "type": "string" },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["spaceId", "name"]
            }
        },
        {
            "name": "create_task_list",
            "description": "Create a list — the board tasks actually live on. It comes with its three default columns, so create_task works against it immediately. Needs `tasks:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "spaceId": { "type": "string", "description": "From list_task_spaces." },
                    "name": { "type": "string" },
                    "folderId": { "type": "string", "description": "Optional; omit to hang the list straight off the space." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["spaceId", "name"]
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
            "name": "link_pull_request",
            "description": "Link a GitHub pull request to a task by its URL, for a PR that doesn't name the task (`cac#12`, a client folio) nor comes from a branch named after it — those link themselves. The repository must be connected to the task's organization through the cac GitHub App. Adds the PR to the task's Development panel (see get_task `git`) and one line to the thread; it changes nothing else (a merged PR does not close the task). Needs `tasks:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The task." },
                    "url": { "type": "string", "description": "https://github.com/{owner}/{repo}/pull/{number}" },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id", "url"]
            }
        },
        {
            "name": "edit_task_comment",
            "description": "Correct a comment you wrote on a task. Only your own: cac refuses anyone else's. Replaces the text outright — there is no history. Needs `tasks:manage`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Task id." },
                    "commentId": { "type": "string", "description": "From get_task." },
                    "body": { "type": "string", "description": "The replacement text, markdown." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id", "commentId", "body"]
            }
        },
        {
            "name": "delete_task_comment",
            "description": "Remove a comment you wrote on a task. Only your own. Unlike a report comment this leaves no trace, and images it cited are detached with it unless something else still references them. Needs `tasks:manage`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Task id." },
                    "commentId": { "type": "string", "description": "From get_task." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id", "commentId"]
            }
        },
        {
            "name": "list_collections",
            "description": "Request collections you can reach, personal and org-shared, with your permission on each. Use it to resolve a name to the id get_collection takes.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_collection",
            "description": "One collection's tree: its folders and saved requests, with method, URL, headers and body. Read it to learn how an API is called before writing code against it.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "From list_collections." } },
                "required": ["id"]
            }
        },
        {
            "name": "create_collection",
            "description": "Create a request collection — somewhere to leave an API you just described, ready to run. Personal unless you pass orgId, which shares it with that organization. Needs `collections:write`. Editing, deleting and sharing are not available to a token.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "description": { "type": "string", "description": "Optional." },
                    "orgId": { "type": "string", "description": "Optional. Omit for a personal collection; set it to share with an organization you belong to." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["name"]
            }
        },
        {
            "name": "compress_image",
            "description": "Convert and shrink an image on this machine: webp, avif, jpeg, png, gif or bmp, with optional quality and a maximum width. Reads and writes files by path — nothing is uploaded and no server is involved. Needs no scope; it never touches cac.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the image to read." },
                    "outPath": { "type": "string", "description": "Where to write it. Omit to write beside the original with the new extension." },
                    "format": {
                        "type": "string",
                        "enum": ["webp", "avif", "jpeg", "png", "gif", "bmp"],
                        "description": "Defaults to webp."
                    },
                    "quality": { "type": "integer", "description": "1-100, for the lossy formats. Ignored by png, gif and bmp." },
                    "maxWidth": { "type": "integer", "description": "Scale down so the width is at most this. Never scales up." },
                    "dryRun": { "type": "boolean", "description": "Report what would be written without writing it." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "install_skill",
            "description": "Install (or update) the cac-work skill for Claude Code on this machine: how to find a repository's place in cac, read its docs before starting, register the work as a task, record decisions and keep it all up to date. Writes one fixed file, skills/cac-work/SKILL.md in the Claude Code config folder, with the text shipped inside this cac app — nothing is downloaded. ASK THE USER FIRST; call it only when they agreed. It takes effect in the next session. Needs no scope; it never touches cac.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dryRun": { "type": "boolean", "description": "Report where it would write without writing." }
                }
            }
        },
        {
            "name": "list_devices",
            "description": "Devices sending passive telemetry (mobile apps): each with its name (label), who uses it (subject — an id such as an employee number, never an email), project, app version, last seen, last heartbeat, error/warning counts and the project's health alerts that its latest state breaks. `query` searches name, subject and device id. Use to find a device to investigate.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "projectId": { "type": "string" },
                    "query": { "type": "string", "description": "Search by device name, subject (e.g. employee id) or device id." },
                    "cursor": { "type": "string", "description": "nextCursor from a previous call, for the next page." }
                }
            }
        },
        {
            "name": "get_device_timeline",
            "description": "Diagnostics for one device: its latest state flattened to key=value, the project's health alerts it breaks, its heartbeats with the gaps between them, then the timeline — errors and warnings verbatim (severity decided by the server), successful traffic grouped by endpoint+status, other events with their content. Use to root-cause a field incident. Filter by time (`since`/`until`: ISO date, epoch ms, or relative like 30m, 6h, 2d), crumb `types` and `minSeverity`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deviceId": { "type": "string" },
                    "projectId": { "type": "string", "description": "Needed when the same device sends to more than one project." },
                    "sessionId": { "type": "string" },
                    "since": { "type": "string", "description": "ISO date, epoch ms, or relative: 30m, 6h, 2d." },
                    "until": { "type": "string", "description": "ISO date, epoch ms, or relative." },
                    "types": { "type": "array", "items": { "type": "string" }, "description": "Only these crumb types, e.g. [\"error\", \"heartbeat\"]." },
                    "minSeverity": { "type": "string", "enum": ["info", "warn", "error"] },
                    "limit": { "type": "integer", "description": "batches to inspect, default 20, max 200" }
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
        },
        {
            "name": "list_docs",
            "description": "Which spaces, folders and lists carry project documentation, who is responsible for each, and which ones nobody has confirmed in over 90 days. Start here when asked what is documented or what is out of date.",
            "inputSchema": {
                "type": "object",
                "properties": { "orgId": { "type": "string" } },
                "required": ["orgId"]
            }
        },
        {
            "name": "get_doc",
            "description": "One node's documentation HOME (its four tabs), a piece at a time — a whole doc runs to tens of thousands of characters. Below the home hangs a tree of subpages: if the outline has a `pages` field, list them with list_doc_pages and read one with get_doc_page.\n\nWithout `tab`: the OUTLINE — who maintains it, when it was reviewed, and for each of its four tabs (overview, runbook, decisions, links; the name is in `key`) its size, `bodyHash`, and its headings, each with a `sectionHash`. Plus the decision log's titles. No bodies.\nWith `tab`: that tab's full markdown.\nWith `tab` + `section`: just that heading and what's under it, down to the next heading of the same or a higher level.\n\nRewrite one heading with write_doc_section and its sectionHash; replace a whole tab with write_doc_tab and its bodyHash.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string", "description": "The id of the space, folder or list. Use list_task_spaces to find it." },
                    "tab": { "type": "string", "enum": ["overview", "runbook", "decisions", "links"], "description": "Optional. Read only this tab." },
                    "section": { "type": "string", "description": "Optional, with tab. A heading's text, with or without the #s, e.g. \"Correo\" or \"## Correo\"." },
                    "full": { "type": "boolean", "description": "Optional. The whole document at once, as it used to come. Large; prefer the outline." }
                },
                "required": ["kind", "ownerId"]
            }
        },
        {
            "name": "append_doc_tab",
            "description": "Add text to the end of a tab without touching what is already there. It cannot delete anything, so it is safe while somebody has the document open — but it only adds: to correct something that's already written, use write_doc_section, or the old version stays next to the new one. Answers with the tab's new bodyHash, not the document. Needs a token with the `docs:write` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "tab": { "type": "string", "enum": ["overview", "runbook", "decisions", "links"] },
                    "text": { "type": "string", "description": "Markdown. Lands after a blank line, so it reads as a new paragraph or section." },
                    "dryRun": { "type": "boolean", "description": "Validate the target and the token's permission without writing." }
                },
                "required": ["kind", "ownerId", "tab", "text"]
            }
        },
        {
            "name": "record_decision",
            "description": "Add an entry to a project's decision log: what was decided, why, and who decided it. Taken outside cac — a client's email, a call — it comes from the document. Taken while working a task, pass originTaskId and the entry links back to that task. The log is append-only: entries cannot be edited or deleted afterwards, so write it as it should read in a year. Needs a token with the `docs:write` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "title": { "type": "string", "description": "What was decided, in one line." },
                    "body": { "type": "string", "description": "Why. The reasoning is what makes the entry worth keeping." },
                    "tag": { "type": "string", "description": "Optional: architecture, vendor, scope…" },
                    "decidedBy": { "type": "string", "description": "The name or username of the person in this organization who made the call, when it wasn't you. Signing it with the token's owner would say they decided it, which is what whoever reads it will believe." },
                    "originTaskId": { "type": "string", "description": "Optional. The task this decision came out of; the entry links back to it. It must be a real task in the same organization, or the entry is refused — the log can't be edited, so a link to nothing would stay forever. One task per decision." },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "title"]
            }
        },
        {
            "name": "write_doc_tab",
            "description": "Replace a whole tab's markdown. To change one heading, use write_doc_section instead — rewriting 50 000 characters to fix a paragraph is how work gets lost. Pass the tab's `bodyHash` from get_doc; without a matching hash the save is refused, because somebody may have written into it since. On a refusal the result carries `conflict: true` and that tab's current text, so merge and send again. Answers with the new bodyHash, not the document. Needs a token with the `docs:manage` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "tab": { "type": "string", "enum": ["overview", "runbook", "decisions", "links"] },
                    "body": { "type": "string", "description": "Markdown. Replaces the section entirely." },
                    "baseHash": { "type": "string", "description": "The `bodyHash` this section had when you read it. Omit only for a section that has never been saved." },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "tab", "body"]
            }
        },
        {
            "name": "write_doc_section",
            "description": "Rewrite what's under one heading of a tab, and nothing else. The heading line stays; `body` replaces everything below it down to the next heading of the same or a higher level. Read it first with get_doc (tab + section, or the outline) and pass its `sectionHash`: if the section changed since, nothing is written and you get its current text to merge. If only some OTHER part of the tab changed meanwhile, the write goes through anyway. A heading that appears twice is refused, since it doesn't say which one. Needs a token with the `docs:manage` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "tab": { "type": "string", "enum": ["overview", "runbook", "decisions", "links"] },
                    "section": { "type": "string", "description": "The heading's text, with or without the #s." },
                    "sectionHash": { "type": "string", "description": "From get_doc. Says the section is still what you read." },
                    "body": { "type": "string", "description": "Markdown for under the heading. Don't repeat the heading itself." },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "tab", "section", "sectionHash", "body"]
            }
        },
        {
            "name": "notify_me",
            "description": "Notify the person who owns this token — and only them: there is no way to send it to anyone else. It lands in their bell, on their phone and as a desktop notice. Use it when you stop and need them: a decision to make, a blocker, a long job that finished. Not for progress updates: at most 10 every 10 minutes. Needs a token with the `notify:me` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "What they need to know, in one line (max 120): \"Stopped: should v1.7.2 go out now?\"" },
                    "body": { "type": "string", "description": "Optional detail (max 1000)." },
                    "link": { "type": "string", "description": "Optional path inside cac to open when they click it, e.g. /tasks?item=<id>. External URLs are refused." },
                    "orgId": { "type": "string", "description": "Which organization's bell. Optional when they belong to only one; if they belong to several and you leave it out, the answer lists them." },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["title"]
            }
        },
        {
            "name": "list_posts",
            "description": "The organizations' feedback wall: posts (announcements from the platform first, then the newest), 20 at a time, each with author, organization, audience, body, reaction counts and number of comments. Only what the token's owner can see. Pass nextCursor back as `cursor` for the next page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cursor": { "type": "string", "description": "nextCursor from a previous call." }
                }
            }
        },
        {
            "name": "get_post",
            "description": "One post of the feedback wall with all its comments (and their reactions).",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "create_post",
            "description": "Post on the feedback wall, in the name of the token's owner and marked as written by an agent. `feedback` is published right away for an organization (`orgId`, where the owner is admin or member) to `platform` (that organization and the cac team) or `everyone` (every organization). An `announcement` reaches EVERY organization, so it is NOT published: it is saved as a DRAFT only its owner sees, and they get a notification to review, edit and publish it themselves in the app — use it to help write announcements. Only a superadmin's token can draft one. Markdown body; images must be uploaded first. Needs `posts:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["feedback", "announcement"] },
                    "orgId": { "type": "string", "description": "For feedback: the organization it speaks for." },
                    "audience": { "type": "string", "enum": ["platform", "everyone"], "description": "For feedback. Defaults to platform." },
                    "title": { "type": "string", "description": "Optional, max 140." },
                    "body": { "type": "string", "description": "Markdown." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["kind", "body"]
            }
        },
        {
            "name": "comment_post",
            "description": "Comment on a post of the feedback wall (one the token's owner can see). Append-only. The post's author and earlier commenters are notified. Needs `posts:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The post." },
                    "body": { "type": "string", "description": "Markdown." },
                    "dryRun": { "type": "boolean", "description": "Validate without writing." }
                },
                "required": ["id", "body"]
            }
        },
        {
            "name": "react_post",
            "description": "Put (or take away, with on=false) an emoji reaction on a post of the feedback wall, or on one of its comments. Accepted emoji: 👍 ❤️ 😂 🎉 👀 ✅ 🙏 🔥. Needs `posts:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The post." },
                    "commentId": { "type": "string", "description": "Optional: react to this comment of the post instead." },
                    "emoji": { "type": "string" },
                    "on": { "type": "boolean", "description": "Defaults to true." }
                },
                "required": ["id", "emoji"]
            }
        },
        {
            "name": "request_doc_review",
            "description": "Ask a person to review a doc after you changed it — you can't sign a review yourself, and that's on purpose: a signed review says a PERSON checked it's still true. The doc's maintainer and the superadmins get a notification, and the doc shows \"review requested\" next to its freshness until someone signs. Asking again replaces the pending request instead of piling up. Needs a token with the `docs:write` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "note": { "type": "string", "description": "What changed and what to look at, in one line (max 280). It's what lets them start in the right place instead of rereading everything." },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId"]
            }
        },
        {
            "name": "update_doc",
            "description": "Set who is responsible for a document, or the one line pinned above that list's board. Cannot mark a document reviewed — that says a person confirmed it still works, and only a superadmin signs it from the app; use request_doc_review to ask for one. Needs a token with the `docs:manage` scope.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "owner": { "type": "string", "description": "Name or username of a member of this organization. Empty string leaves it without one." },
                    "pinnedLine": { "type": "string", "description": "What somebody needs to know before picking up a card from this list. Empty string removes it." },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId"]
            }
        },
        {
            "name": "list_doc_pages",
            "description": "The tree of subpages below a node's documentation home (space, folder or list): each page's id, title, link and children. A doc is a home with four fixed tabs plus as many pages as it needs, nested without limit — create one per topic instead of growing a tab past a few thousand characters.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" }
                },
                "required": ["kind", "ownerId"]
            }
        },
        {
            "name": "get_doc_page",
            "description": "One subpage. Without `section`: its outline — title, breadcrumb, `bodyHash`, headings each with a `sectionHash`, and its children. With `section`: that heading and what's under it. With `full`: the whole body too.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "pageId": { "type": "string" },
                    "section": { "type": "string" },
                    "full": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "pageId"]
            }
        },
        {
            "name": "list_repo_docs",
            "description": "The markdown files of the GitHub repos linked to a space (docs as code): README, docs/… — each with its id, path and title, grouped by repo with its branch and when it last synced. Read-only: they are edited in the repository with a pull request, and cac's copy updates on every push to the default branch. Get the spaceId from list_task_spaces.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "spaceId": { "type": "string" }
                },
                "required": ["spaceId"]
            }
        },
        {
            "name": "get_repo_doc",
            "description": "One markdown file from a linked repo (from list_repo_docs or a search hit of kind `repoDoc`). Without `section`: its outline — title, path, repo, branch, GitHub URL and headings. With `section`: that heading and what's under it. With `full`: the whole body too. Read-only: to change it, edit the file in the repo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "section": { "type": "string" },
                    "full": { "type": "boolean" }
                },
                "required": ["id"]
            }
        },
        {
            "name": "create_doc_page",
            "description": "Create a subpage under a node's documentation home, or under another page with `parentId`. Creates the document if the node had none. Returns its `pageId` and the in-app `link` to paste anywhere. Needs a token with `docs:write` (creating only adds).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "title": { "type": "string" },
                    "parentId": { "type": "string", "description": "Optional. The page to hang it from; without it, it hangs from the home." },
                    "afterId": { "type": "string", "description": "Optional. The sibling to place it after; without it, last." },
                    "body": { "type": "string", "description": "Optional. Markdown." },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "title"]
            }
        },
        {
            "name": "append_doc_page",
            "description": "Add text to the end of a page without reading it first — safe while someone has it open. Needs `docs:write`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "pageId": { "type": "string" },
                    "text": { "type": "string" },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "pageId", "text"]
            }
        },
        {
            "name": "write_doc_page",
            "description": "Rename a page and/or replace its whole body. Replacing the body needs `baseHash` (the `bodyHash` you read): if someone saved since, you get `conflict` with the current body to merge. Needs `docs:manage`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "pageId": { "type": "string" },
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "baseHash": { "type": "string" },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "pageId"]
            }
        },
        {
            "name": "write_doc_page_section",
            "description": "Rewrite what's under one heading of a page, keeping the heading. Needs the `sectionHash` from get_doc_page. Needs `docs:manage`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "pageId": { "type": "string" },
                    "section": { "type": "string" },
                    "sectionHash": { "type": "string" },
                    "body": { "type": "string" },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "pageId", "section", "sectionHash", "body"]
            }
        },
        {
            "name": "move_doc_page",
            "description": "Move a page: to another parent (`parentId`, empty for the home) and/or next to a sibling (`afterId` or `beforeId`). A page cannot go under itself or its own subpages. Its link does not change. Needs `docs:manage`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "pageId": { "type": "string" },
                    "parentId": { "type": "string" },
                    "afterId": { "type": "string" },
                    "beforeId": { "type": "string" },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "pageId"]
            }
        },
        {
            "name": "delete_doc_page",
            "description": "Send a page and its subpages to the trash. Nothing is destroyed: a person restores it from the app. Needs `docs:manage`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["space", "folder", "list"] },
                    "ownerId": { "type": "string" },
                    "pageId": { "type": "string" },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["kind", "ownerId", "pageId"]
            }
        }
    ])
}

/// De dónde viene un fichero que se adjunta: una URL o una ruta del disco.
#[derive(Debug, PartialEq)]
enum AttachmentSource {
    Url(String),
    Path(std::path::PathBuf),
}

/// `url` o `path`, exactamente uno.
fn attachment_source(args: &Value) -> Result<AttachmentSource, String> {
    match (arg_str(args, "url"), arg_str(args, "path")) {
        (Some(_), Some(_)) => Err("give `url` or `path`, not both".into()),
        (Some(url), None) => Ok(AttachmentSource::Url(url)),
        (None, Some(path)) => {
            let p = std::path::PathBuf::from(path);
            if !p.is_absolute() {
                return Err("`path` has to be absolute".into());
            }
            Ok(AttachmentSource::Path(p))
        }
        (None, None) => Err("give `url` or `path`".into()),
    }
}

/// Los bytes, el tipo y el nombre por defecto. Una ruta pasa por las mismas
/// guardas que soltar un fichero en la app (`dropped::read_path`).
fn load_source(source: &AttachmentSource) -> Result<(Vec<u8>, String, String), String> {
    match source {
        AttachmentSource::Url(url) => {
            let (bytes, ctype) = fetch_bytes(url)?;
            let name = url
                .rsplit('/')
                .next()
                .map(|s| s.split(['?', '#']).next().unwrap_or(s).to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "attachment".to_string());
            Ok((bytes, ctype, name))
        }
        AttachmentSource::Path(path) => {
            let bytes = crate::dropped::read_path(path).map_err(|e| match e.as_str() {
                "type-not-allowed" => format!(
                    "{} can't be attached: only images, PDF, office documents, audio, video, zip or csv",
                    path.display()
                ),
                "too-large" => format!("{} is bigger than the 30 MB an attachment can be", path.display()),
                "not-found" => format!("{} doesn't exist", path.display()),
                other => format!("{}: {other}", path.display()),
            })?;
            let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.clone());
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "attachment".to_string());
            Ok((bytes, crate::dropped::mime_of(&real).to_string(), name))
        }
    }
}

/// El markdown de un adjunto: una imagen se enseña, lo demás se enlaza (un PDF
/// se ve como tarjeta en la app). Antes las notas devolvían siempre `![…]`,
/// también para un PDF, que salía como una imagen rota.
fn attachment_markdown(file_name: &str, content_type: &str, url: &str) -> String {
    if content_type.to_ascii_lowercase().starts_with("image/") {
        format!("![{file_name}]({url})")
    } else {
        format!("[{file_name}]({url})")
    }
}

/// Un servicio desplegable de un servidor, por su id. La ruta lista todos: no
/// hay una para uno solo.
fn find_deployable(cfg: &Cfg, server: &str, id: &str) -> Result<Value, String> {
    let list = api_get(cfg, &format!("/api/v1/servers/{}/deployables", urlencode(server)))?;
    list.as_array()
        .and_then(|a| a.iter().find(|d| d.get("id").and_then(|v| v.as_str()) == Some(id)))
        .cloned()
        .ok_or_else(|| format!("No deployable {id} on server {server}: use list_deployables"))
}

/// El cuerpo del PATCH de un servicio: lo que se pide, sobre lo que ya tiene.
///
/// La ruta pide la fila entera —`name`, `environment`, `repoFullName` y
/// `onCINotify` no son opcionales—, así que lo que no se manda se rellena con
/// lo actual en vez de borrarlo. Los campos opcionales del servidor (punteros)
/// sólo van si se piden: ausentes, no se tocan.
///
/// **El comando de migraciones no se toca nunca desde aquí**: corre en el
/// servidor, y es de una persona en la app. Pedirlo es un error, no un silencio.
fn deploy_update_body(current: &Value, args: &Value) -> Result<(Value, Vec<String>), String> {
    if args.get("migrateCommand").is_some() {
        return Err("The migration command runs on the server: change it in the app, not with a token".into());
    }
    let pick = |key: &str| -> Value {
        args.get(key).cloned().unwrap_or_else(|| current.get(key).cloned().unwrap_or(json!("")))
    };
    let mut body = json!({
        "name": pick("name"),
        "environment": pick("environment"),
        "repoFullName": pick("repoFullName"),
        "onCINotify": pick("onCINotify"),
    });
    if body["onCINotify"].as_str().unwrap_or("").is_empty() {
        body["onCINotify"] = json!("record");
    }
    let mut changed = vec![];
    for key in ["name", "environment", "repoFullName", "onCINotify"] {
        if args.get(key).is_some() {
            changed.push(key.to_string());
        }
    }
    for key in ["buildWorkflow", "shortTags", "branch", "buildOnHost", "dockerfile", "buildContext"] {
        if let Some(v) = args.get(key) {
            body[key] = v.clone();
            changed.push(key.to_string());
        }
    }
    if changed.is_empty() {
        return Err("Nothing to change: send at least one field".into());
    }
    Ok((body, changed))
}

/// La lista de secrets por nombre que se guarda: por defecto, lo que hay con
/// lo pedido encima (por nombre); `remove` quita; `replace` deja sólo lo
/// pedido. La ruta reemplaza la lista entera, así que «añadir uno» tiene que
/// mandar también los demás o se perderían.
fn merge_secret_refs(current: &[Value], set: &[Value], remove: &[String], replace: bool) -> Result<Vec<Value>, String> {
    let entry = |v: &Value| -> Result<Value, String> {
        let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
        let op_ref = v.get("opRef").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() || op_ref.is_empty() {
            return Err("Each ref needs a name and an opRef (op://vault/item/field)".into());
        }
        let usage = v.get("usage").and_then(|n| n.as_str()).unwrap_or("runtime").to_string();
        if !["runtime", "build", "both"].contains(&usage.as_str()) {
            return Err(format!("usage of {name} must be runtime, build or both"));
        }
        Ok(json!({ "name": name, "opRef": op_ref, "usage": usage }))
    };
    let mut out: Vec<Value> = if replace {
        vec![]
    } else {
        current
            .iter()
            .map(|v| {
                json!({
                    "name": v.get("name").cloned().unwrap_or(json!("")),
                    "opRef": v.get("opRef").cloned().unwrap_or(json!("")),
                    "usage": v.get("usage").and_then(|u| u.as_str()).filter(|u| !u.is_empty()).unwrap_or("runtime"),
                })
            })
            .collect()
    };
    for v in set {
        let e = entry(v)?;
        match out.iter_mut().find(|o| o["name"] == e["name"]) {
            Some(slot) => *slot = e,
            None => out.push(e),
        }
    }
    out.retain(|o| !remove.iter().any(|r| o["name"].as_str() == Some(r.as_str())));
    Ok(out)
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

        "add_report_comment" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let body_md = arg_str(args, "body").ok_or("body is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/reports/{}", urlencode(&id)));
                return dry_run(cfg, "reports:write", target);
            }
            // multipart even without files: it's what the endpoint takes, so a
            // reply with a screenshot and one without go the same way.
            let detail = api_form(
                cfg,
                "POST",
                &format!("/api/v1/reports/{}/comments", urlencode(&id)),
                vec![("body", body_md)],
            )?;
            let comments = detail.get("comments").and_then(|v| v.as_array());
            let added = comments.and_then(|c| c.last());
            Ok(json!({
                "id": added.and_then(|c| c.get("id")),
                "author": added.and_then(|c| c.get("author")),
                "createdAt": added.and_then(|c| c.get("createdAt")),
                "reportId": id,
                "commentsOnReport": comments.map(|c| c.len()),
            }))
        }

        "edit_report_comment" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let comment_id = arg_str(args, "commentId").ok_or("commentId is required")?;
            let body_md = arg_str(args, "body").ok_or("body is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/reports/{}", urlencode(&id)));
                return dry_run(cfg, "reports:manage", target);
            }
            let detail = api_form(
                cfg,
                "PATCH",
                &format!(
                    "/api/v1/reports/{}/comments/{}",
                    urlencode(&id),
                    urlencode(&comment_id)
                ),
                vec![("body", body_md)],
            )?;
            Ok(json!({
                "commentId": comment_id,
                "reportId": id,
                "commentsOnReport": detail.get("comments").and_then(|v| v.as_array()).map(|c| c.len()),
            }))
        }

        "delete_report_comment" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let comment_id = arg_str(args, "commentId").ok_or("commentId is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/reports/{}", urlencode(&id)));
                return dry_run(cfg, "reports:manage", target);
            }
            api_delete(
                cfg,
                &format!(
                    "/api/v1/reports/{}/comments/{}",
                    urlencode(&id),
                    urlencode(&comment_id)
                ),
            )?;
            Ok(json!({
                "commentId": comment_id,
                "reportId": id,
                "withdrawn": true,
                "note": "Gone for the reporter and any tenant app; still visible inside cac, marked."
            }))
        }

        "update_report" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/reports/{}", urlencode(&id)));
                return dry_run(cfg, "reports:manage", target);
            }
            let mut patch = serde_json::Map::new();
            for key in ["status", "priority", "category", "area"] {
                if let Some(v) = arg_str(args, key) {
                    patch.insert(key.to_string(), json!(v));
                }
            }
            // Present-and-empty means unassign, so this one can't use arg_str's
            // "missing or empty" shape.
            if let Some(v) = args.get("assigneeUserId").and_then(|v| v.as_str()) {
                patch.insert("assigneeUserId".to_string(), json!(v));
            }
            if patch.is_empty() {
                return Err(
                    "nothing to change: pass status, priority, category, area or assigneeUserId"
                        .into(),
                );
            }
            let detail = api_patch(
                cfg,
                &format!("/api/v1/reports/{}", urlencode(&id)),
                Value::Object(patch),
            )?;
            Ok(json!({
                "id": id,
                "folio": detail.get("folio"),
                "status": detail.get("status"),
                "priority": detail.get("priority"),
                "category": detail.get("category"),
                "area": detail.get("area"),
                "assignee": detail.get("assigneeName"),
            }))
        }

        "add_note_attachment" | "add_task_attachment" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let (owner, scope) = if name == "add_note_attachment" {
                ("notes", "notes:write")
            } else {
                ("tasks", "tasks:write")
            };
            // Antes que el dryRun: «url y path a la vez» es un error del
            // argumento, y un dryRun que lo dejara pasar mentiría.
            let source = attachment_source(args)?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/{owner}/{}", urlencode(&id)));
                return dry_run(cfg, scope, target);
            }
            // Leído aquí y no entregado como base64: 30 MB por el protocolo
            // MCP serían un argumento enorme, codificado, en memoria y en logs.
            let (bytes, ctype, default_name) = load_source(&source)?;
            let file_name = arg_str(args, "fileName").unwrap_or(default_name);
            let att = api_upload(
                cfg,
                &format!("/api/v1/{owner}/{}/attachments", urlencode(&id)),
                &file_name,
                &ctype,
                bytes,
            )?;
            let rel = att.get("url").and_then(|v| v.as_str()).unwrap_or_default();
            Ok(json!({
                "id": att.get("id"),
                "fileName": att.get("fileName"),
                "bytes": att.get("bytes"),
                // Listo para pegar: quien llama no tiene por qué saber cómo
                // escribe cac la referencia a un adjunto.
                "markdown": attachment_markdown(&file_name, &ctype, rel),
            }))
        }

        "list_servers" => {
            let data = api_get(cfg, "/api/v1/servers")?;
            let items: Vec<Value> = data
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|v| {
                    json!({
                        "id": v.get("id"), "name": v.get("name"), "type": v.get("type"),
                        "status": v.get("status"), "orgId": v.get("orgId"),
                    })
                })
                .collect();
            Ok(json!({ "servers": items }))
        }

        "list_deployables" => {
            let server = arg_str(args, "serverId").ok_or("serverId is required")?;
            let data = api_get(cfg, &format!("/api/v1/servers/{}/deployables", urlencode(&server)))?;
            Ok(json!({ "deployables": data }))
        }

        "list_backups" => {
            let server = arg_str(args, "serverId").ok_or("serverId is required")?;
            let status = api_get(cfg, &format!("/api/v1/servers/{}/backups/status", urlencode(&server)))?;
            let targets = api_get(cfg, &format!("/api/v1/servers/{}/backups/targets", urlencode(&server)))?;
            Ok(json!({ "status": status, "databases": targets }))
        }

        "get_backup_history" => {
            let server = arg_str(args, "serverId").ok_or("serverId is required")?;
            let target = arg_str(args, "targetId").ok_or("targetId is required")?;
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(20).clamp(1, 200);
            let data = api_get(cfg, &format!(
                "/api/v1/servers/{}/backups/targets/{}/history?limit={limit}",
                urlencode(&server), urlencode(&target)
            ))?;
            Ok(json!({ "backups": data }))
        }

        "get_deploy_config" => {
            let server = arg_str(args, "serverId").ok_or("serverId is required")?;
            let id = arg_str(args, "deployableId").ok_or("deployableId is required")?;
            let current = find_deployable(cfg, &server, &id)?;
            let base = format!("/api/v1/servers/{}/deployables/{}", urlencode(&server), urlencode(&id));
            let refs = api_get(cfg, &format!("{base}/secret-refs"))?;
            // Los build args salen del Dockerfile del repo, por la GitHub App:
            // si no se pueden leer, el resto sigue valiendo.
            let build_args = match api_get(cfg, &format!("{base}/build-args")) {
                Ok(v) => v,
                Err(e) => json!({ "unavailable": e }),
            };
            Ok(json!({ "deployable": current, "secretRefs": refs, "buildArgs": build_args }))
        }

        "create_deployable" => {
            let server = arg_str(args, "serverId").ok_or("serverId is required")?;
            let path = format!("/api/v1/servers/{}/deployables", urlencode(&server));
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &path);
                return dry_run(cfg, "deploys:manage", target);
            }
            let mut body = json!({});
            for key in ["name", "stack", "serviceName", "imageRepo"] {
                body[key] = json!(arg_str(args, key).ok_or(format!("{key} is required"))?);
            }
            for key in ["environment", "repoFullName"] {
                if let Some(v) = arg_str(args, key) {
                    body[key] = json!(v);
                }
            }
            if let Some(v) = args.get("shortTags").and_then(|v| v.as_bool()) {
                body["shortTags"] = json!(v);
            }
            let created = api_post(cfg, &path, body)?;
            Ok(json!({ "created": created }))
        }

        "update_deploy_config" => {
            let server = arg_str(args, "serverId").ok_or("serverId is required")?;
            let id = arg_str(args, "deployableId").ok_or("deployableId is required")?;
            let current = find_deployable(cfg, &server, &id)?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "deploys:manage", Ok(current));
            }
            let (body, changed) = deploy_update_body(&current, args)?;
            let updated = api_patch(
                cfg,
                &format!("/api/v1/servers/{}/deployables/{}", urlencode(&server), urlencode(&id)),
                body,
            )?;
            Ok(json!({ "updated": updated, "changed": changed }))
        }

        "set_secret_refs" => {
            let server = arg_str(args, "serverId").ok_or("serverId is required")?;
            let id = arg_str(args, "deployableId").ok_or("deployableId is required")?;
            let path = format!(
                "/api/v1/servers/{}/deployables/{}/secret-refs",
                urlencode(&server),
                urlencode(&id)
            );
            let current = api_get(cfg, &path)?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "deploys:manage", Ok(current));
            }
            let set: Vec<Value> = args.get("refs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let remove: Vec<String> = arg_names(args, "remove").unwrap_or_default();
            if set.is_empty() && remove.is_empty() && !arg_bool(args, "replace") {
                return Err("Nothing to change: send refs to add or change, or remove".into());
            }
            let refs = merge_secret_refs(
                current.as_array().map(|a| a.as_slice()).unwrap_or(&[]),
                &set,
                &remove,
                arg_bool(args, "replace"),
            )?;
            let saved = api_put(cfg, &path, json!({ "refs": refs }))?;
            Ok(json!({ "secretRefs": saved }))
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

        "search" => {
            // Sin orgId, el servidor busca en las orgs de las que el token es
            // miembro —nunca en todas, tampoco con un token de superadmin—.
            // La regla vive allí y no aquí: un cliente que calculara las orgs
            // por su cuenta podría ensancharla sin que nadie se enterara (#119).
            let q = search_query(args)?;
            let data = api_get(cfg, &format!("/api/v1/search/{q}"))?;
            Ok(search_results(&data))
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
            // Explícito por lo mismo que `visibility` justo debajo, y por su
            // propia razón: sin esto la subtarea se crea igual, pero suelta y
            // como hermana de su padre. Sale bien, no avisa de nada, y anidarla
            // hay que ir a hacerlo a mano en el tablero.
            if let Some(p) = arg_str(args, "parentId") {
                body["parentId"] = json!(p);
            }
            // Forwarded explicitly, and the reason is a scar: this argument was
            // accepted by the tool and dropped here, so asking for "internal"
            // published a note onto a client's board. An unknown key going
            // quietly missing is tolerable for most parameters and not for one
            // whose absence means "show this to the customer".
            if let Some(v) = arg_str(args, "visibility") {
                body["visibility"] = json!(v);
            }
            // Etiquetas, responsables y vencimiento se resuelven **antes** de
            // crear: un nombre que no existe tiene que fallar sin dejar detrás
            // una tarea a medias.
            let wants_names =
                arg_names(args, "tags").is_some() || arg_names(args, "assignees").is_some();
            if wants_names || arg_str(args, "dueAt").is_some() {
                let org_id = if wants_names {
                    let spaces = api_get(cfg, "/api/v1/task-spaces/")?;
                    org_of_list(&spaces, &list_id)
                        .ok_or_else(|| format!("List {list_id} is not in any space you can see"))?
                } else {
                    String::new()
                };
                resolve_task_extras(cfg, &org_id, args, &mut body)?;
            }
            // Crear no admite etiquetas: van en un PATCH justo después, con los
            // ids ya resueltos arriba.
            let tag_ids = body.as_object_mut().and_then(|o| o.remove("tagIds"));
            let data = api_post(cfg, &format!("/api/v1/task-lists/{list_id}/tasks"), body)?;
            if let (Some(ids), Some(id)) = (tag_ids, data.get("id").and_then(|v| v.as_str())) {
                api_patch(
                    cfg,
                    &format!("/api/v1/tasks/{}", urlencode(id)),
                    json!({ "tagIds": ids }),
                )?;
            }
            // La checklist en la misma llamada: antes eran N+1 llamadas, una
            // por línea. Cada subtarea lleva su clave derivada de la del padre,
            // así que reintentar entera no duplica ni el padre ni las líneas.
            let mut created_subtasks = vec![];
            if let (Some(titles), Some(parent)) = (subtask_titles(args)?, data.get("id").and_then(|v| v.as_str())) {
                let key = arg_str(args, "idempotencyKey");
                for (i, title) in titles.iter().enumerate() {
                    let mut sub = json!({ "title": title, "parentId": parent });
                    if let Some(k) = &key {
                        sub["idempotencyKey"] = json!(subtask_key(k, i));
                    }
                    match api_post(cfg, &format!("/api/v1/task-lists/{list_id}/tasks"), sub) {
                        Ok(d) => created_subtasks.push(json!({ "id": d.get("id"), "seq": d.get("seq"), "title": d.get("title") })),
                        Err(e) => {
                            return Err(format!(
                                "The task {parent} was created, and {} of its {} subtasks; subtask \"{title}\" failed: {e}. Retry with the same idempotencyKey to finish without duplicates.",
                                created_subtasks.len(),
                                titles.len()
                            ))
                        }
                    }
                }
            }
            // Echo back what was created, including the sequence number, so the
            // caller can refer to the task without another round trip.
            Ok(json!({
                "subtasks": created_subtasks,
                "id": data.get("id"),
                "seq": data.get("seq"),
                "title": data.get("title"),
                "listId": data.get("listId"),
                "statusId": data.get("statusId"),
                "priority": data.get("priority"),
                // De vuelta a quien llamó: es la confirmación de que colgó del
                // padre. Pedir `parentId` y recibir un eco sin él es la única
                // señal de que algo se perdió por el camino.
                "parentId": data.get("parentId"),
            }))
        }

        "update_task" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)));
                return dry_run(cfg, "tasks:manage", target);
            }
            let mut body = json!({});
            // visibility rides with the rest, but it is the one key here that
            // changes who can read the item rather than what it says.
            for key in ["title", "description", "priority", "visibility"] {
                if let Some(v) = arg_str(args, key) {
                    body[key] = json!(v);
                }
            }
            // Etiquetas y responsables se resuelven contra la organización de la
            // tarea, que sólo se sabe preguntando por ella.
            if arg_names(args, "tags").is_some() || arg_names(args, "assignees").is_some() {
                let current = api_get(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)))?;
                let org_id = current
                    .get("task")
                    .and_then(|t| t.get("orgId"))
                    .and_then(|v| v.as_str())
                    .ok_or("Could not tell which organization this task belongs to")?
                    .to_string();
                resolve_task_extras(cfg, &org_id, args, &mut body)?;
            } else {
                resolve_task_extras(cfg, "", args, &mut body)?;
            }
            // Moving a card is its own endpoint: the server derives the ordering
            // rank from the neighbours, so a status change can't be a field patch.
            let status_id = move_target(args)?;
            if body.as_object().map(|o| o.is_empty()).unwrap_or(true) && status_id.is_none() {
                return Err(
                    "Nothing to change: send at least one of title, description, priority, visibility, tags, assignees, dueAt, status or statusId"
                        .into(),
                );
            }

            let mut changed: Vec<&str> = vec![];
            if !body.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                api_patch(
                    cfg,
                    &format!("/api/v1/tasks/{}", urlencode(&id)),
                    body.clone(),
                )?;
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

        "create_task_space" => {
            let org_id = arg_str(args, "orgId").ok_or("orgId is required")?;
            let name = arg_str(args, "name").ok_or("name is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, "/api/v1/task-spaces/");
                return dry_run(cfg, "tasks:write", target);
            }
            let mut body = json!({ "orgId": org_id, "name": name });
            if let Some(color) = arg_str(args, "color") {
                body["color"] = json!(color);
            }
            let space = api_post(cfg, "/api/v1/task-spaces/", body)?;
            Ok(json!({
                "spaceId": space.get("id"),
                "name": space.get("name"),
                "note": "A space holds no tasks directly — create a list in it next."
            }))
        }

        "create_task_folder" => {
            let space_id = arg_str(args, "spaceId").ok_or("spaceId is required")?;
            let name = arg_str(args, "name").ok_or("name is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, "/api/v1/task-spaces/");
                return dry_run(cfg, "tasks:write", target);
            }
            let folder = api_post(
                cfg,
                &format!("/api/v1/task-spaces/{}/folders", urlencode(&space_id)),
                json!({ "name": name }),
            )?;
            Ok(
                json!({ "folderId": folder.get("id"), "name": folder.get("name"), "spaceId": space_id }),
            )
        }

        "create_task_list" => {
            let space_id = arg_str(args, "spaceId").ok_or("spaceId is required")?;
            let name = arg_str(args, "name").ok_or("name is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, "/api/v1/task-spaces/");
                return dry_run(cfg, "tasks:write", target);
            }
            let mut body = json!({ "name": name });
            // The route lives under the space even when the list goes in a
            // folder — the folder is where it hangs, not who owns it.
            if let Some(folder_id) = arg_str(args, "folderId") {
                body["folderId"] = json!(folder_id);
            }
            let list = api_post(
                cfg,
                &format!("/api/v1/task-spaces/{}/lists", urlencode(&space_id)),
                body,
            )?;
            Ok(json!({
                "listId": list.get("id"),
                "name": list.get("name"),
                "spaceId": space_id,
                "note": "Ready for create_task; get_board returns its columns."
            }))
        }

        "link_pull_request" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let url = arg_str(args, "url").ok_or("url is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)));
                return dry_run(cfg, "tasks:write", target);
            }
            let link = api_post(
                cfg,
                &format!("/api/v1/tasks/{}/git/prs", urlencode(&id)),
                json!({ "url": url }),
            )?;
            Ok(json!({
                "taskId": id,
                "repo": link.get("repoFullName"),
                "number": link.get("key"),
                "title": link.get("title"),
                "state": link.get("state"),
                "url": link.get("htmlUrl"),
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

        "edit_task_comment" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let comment_id = arg_str(args, "commentId").ok_or("commentId is required")?;
            let body_md = arg_str(args, "body").ok_or("body is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)));
                return dry_run(cfg, "tasks:manage", target);
            }
            // JSON, not multipart: unlike a report comment, a task comment has no
            // images of its own — files hang off the task, and the body cites them.
            api_patch(
                cfg,
                &format!(
                    "/api/v1/tasks/{}/comments/{}",
                    urlencode(&id),
                    urlencode(&comment_id)
                ),
                json!({ "body": body_md }),
            )?;
            Ok(json!({ "commentId": comment_id, "taskId": id, "updated": true }))
        }

        "delete_task_comment" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let comment_id = arg_str(args, "commentId").ok_or("commentId is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/tasks/{}", urlencode(&id)));
                return dry_run(cfg, "tasks:manage", target);
            }
            api_delete(
                cfg,
                &format!(
                    "/api/v1/tasks/{}/comments/{}",
                    urlencode(&id),
                    urlencode(&comment_id)
                ),
            )?;
            Ok(json!({
                "commentId": comment_id,
                "taskId": id,
                "deleted": true,
                "note": "Gone for everyone. Files it cited are detached unless something else still uses them."
            }))
        }

        "list_collections" => {
            let data = api_get(cfg, "/api/v1/collections/")?;
            Ok(json!({ "collections": data }))
        }

        "get_collection" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            api_get(cfg, &format!("/api/v1/collections/{}", urlencode(&id)))
        }

        "create_collection" => {
            let name = arg_str(args, "name").ok_or("name is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, "/api/v1/collections/");
                return dry_run(cfg, "collections:write", target);
            }
            let mut body = json!({ "name": name });
            if let Some(description) = arg_str(args, "description") {
                body["description"] = json!(description);
            }
            // Absent, not null: the field is a nullable pointer server-side and
            // null is what marks a collection personal.
            if let Some(org_id) = arg_str(args, "orgId") {
                body["orgId"] = json!(org_id);
            }
            let created = api_post(cfg, "/api/v1/collections/", body)?;
            Ok(json!({
                "collectionId": created.get("id"),
                "name": created.get("name"),
                "shared": created.get("orgId").map(|v| !v.is_null()),
            }))
        }

        "list_devices" => {
            let mut q = vec![];
            push_q(&mut q, "projectId", arg_str(args, "projectId"));
            push_q(&mut q, "q", arg_str(args, "query"));
            push_q(&mut q, "cursor", arg_str(args, "cursor"));
            let data = api_get(cfg, &format!("/api/v1/telemetry/devices{}", qs(q)))?;
            Ok(compact_devices(&data))
        }

        "get_device_timeline" => {
            let device = arg_str(args, "deviceId").ok_or("deviceId is required")?;
            let project = match arg_str(args, "projectId") {
                Some(p) => p,
                None => resolve_device_project(cfg, &device)?,
            };
            let limit = arg_i64(args, "limit").unwrap_or(20).clamp(1, 200);
            let now = now_ms();
            let mut q = vec![
                format!("deviceId={}", urlencode(&device)),
                format!("projectId={}", urlencode(&project)),
            ];
            push_q(&mut q, "sessionId", arg_str(args, "sessionId"));
            for key in ["since", "until"] {
                if let Some(v) = arg_str(args, key) {
                    let when = parse_when(&v, now).ok_or(format!("{key}: use an ISO date, epoch ms, or 30m / 6h / 2d"))?;
                    q.push(format!("{key}={}", urlencode(&when)));
                }
            }
            let types: Vec<String> = args
                .get("types")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if !types.is_empty() {
                q.push(format!("types={}", urlencode(&types.join(","))));
            }
            push_q(&mut q, "minSeverity", arg_str(args, "minSeverity"));
            q.push(format!("limit={limit}"));
            let data = api_get(cfg, &format!("/api/v1/telemetry/timeline{}", qs(q)))?;
            // La ficha va aparte: si falla (un dispositivo purgado), el timeline
            // que haya sigue valiendo.
            let detail = api_get(
                cfg,
                &format!("/api/v1/telemetry/devices/{}/{}", urlencode(&project), urlencode(&device)),
            )
            .unwrap_or(Value::Null);
            Ok(summarize_timeline(&data, &detail))
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

        // ─── Documentación de proyecto ────────────────────────────────────
        //
        // La otra mitad de la documentación. Todo lo demás lo escribe una persona
        // con la app abierta; esto es para que un agente que acaba de tocar el
        // runbook de un servicio pueda dejarlo escrito, en vez de que se quede sin
        // escribir.
        "list_docs" => {
            let org = arg_str(args, "orgId").ok_or("orgId is required")?;
            let data = api_get(cfg, &format!("/api/v1/docs/?orgId={}", urlencode(&org)))?;
            Ok(json!({ "docs": data }))
        }

        "get_doc" => {
            let (kind, id) = doc_target(args)?;
            let data = api_get(cfg, &format!("/api/v1/docs/{kind}/{id}"))?;
            // `full` es la salida de emergencia: el documento tal cual, como
            // antes. Por defecto, el índice; con `tab`, esa pestaña; y con
            // `section`, sólo ese título.
            if arg_bool(args, "full") {
                return Ok(data);
            }
            let Some(tab) = arg_str(args, "tab") else {
                let mut out = doc_outline(&data);
                // Las páginas, si las hay: sin esto el índice de la portada no
                // dice que hay árbol debajo. Un fallo aquí no tumba el índice.
                if let Ok(tree) = api_get(cfg, &format!("/api/v1/docs/{kind}/{id}/pages")) {
                    if tree.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                        out["pages"] = pages_summary(&tree);
                    }
                }
                return Ok(out);
            };
            let t = doc_tab_of(&data, &tab).ok_or_else(|| {
                format!("No tab \"{tab}\": use overview, runbook, decisions or links")
            })?;
            let body = tab_body(t);
            match arg_str(args, "section") {
                None => Ok(json!({
                    "tab": tab,
                    "bodyHash": t.get("bodyHash"),
                    "updatedAt": t.get("updatedAt"),
                    "body": body,
                    "sections": tab_outline(body),
                })),
                Some(wanted) => {
                    let sec = find_section(body, &wanted)?;
                    Ok(json!({
                        "tab": tab,
                        "tabBodyHash": t.get("bodyHash"),
                        "section": sec.heading,
                        "sectionHash": section_hash(body, &sec),
                        "text": &body[sec.start..sec.end],
                    }))
                }
            }
        }

        "append_doc_tab" => {
            let (kind, id) = doc_target(args)?;
            let tab = doc_tab(args)?;
            let text = arg_str(args, "text").ok_or("text is required")?;
            let path = format!("/api/v1/docs/{kind}/{id}/tabs/{tab}/append");
            if arg_bool(args, "dryRun") {
                return dry_run(
                    cfg,
                    "docs:write",
                    api_get(cfg, &format!("/api/v1/docs/{kind}/{id}")),
                );
            }
            let out = api_post(cfg, &path, json!({ "body": text }))?;
            Ok(short_tab_write(&out, &tab))
        }

        "record_decision" => {
            let (kind, id) = doc_target(args)?;
            let title = arg_str(args, "title").ok_or("title is required")?;
            if arg_bool(args, "dryRun") {
                return dry_run(
                    cfg,
                    "docs:write",
                    api_get(cfg, &format!("/api/v1/docs/{kind}/{id}")),
                );
            }
            let body = decision_body(&title, args);
            let out = api_post(cfg, &format!("/api/v1/docs/{kind}/{id}/decisions"), body)?;
            Ok(recorded_decision(&out))
        }

        "write_doc_tab" => {
            let (kind, id) = doc_target(args)?;
            let tab = doc_tab(args)?;
            let text = arg_str(args, "body").ok_or("body is required")?;
            if arg_bool(args, "dryRun") {
                return dry_run(
                    cfg,
                    "docs:manage",
                    api_get(cfg, &format!("/api/v1/docs/{kind}/{id}")),
                );
            }
            let mut body = json!({ "body": text });
            if let Some(h) = arg_str(args, "baseHash") {
                body["baseHash"] = json!(h);
            }
            let out = api_put(cfg, &format!("/api/v1/docs/{kind}/{id}/tabs/{tab}"), body)?;
            Ok(short_conflict(&out, &tab).unwrap_or_else(|| short_tab_write(&out, &tab)))
        }

        "write_doc_section" => {
            let (kind, id) = doc_target(args)?;
            let tab = doc_tab(args)?;
            let wanted =
                arg_str(args, "section").ok_or("section is required: the heading to rewrite")?;
            let expected = arg_str(args, "sectionHash")
                .ok_or("sectionHash is required: read it with get_doc first")?;
            let content = args
                .get("body")
                .and_then(|v| v.as_str())
                .ok_or("body is required")?;
            if arg_bool(args, "dryRun") {
                return dry_run(
                    cfg,
                    "docs:manage",
                    api_get(cfg, &format!("/api/v1/docs/{kind}/{id}")),
                );
            }
            write_section(cfg, &kind, &id, &tab, &wanted, &expected, content)
        }

        "notify_me" => {
            let title = arg_str(args, "title").ok_or("title is required")?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "notify:me", api_get(cfg, "/api/v1/auth/me"));
            }
            let mut body = json!({ "title": title });
            for key in ["body", "link", "orgId"] {
                if let Some(v) = arg_str(args, key) {
                    body[key] = json!(v);
                }
            }
            api_post(cfg, "/api/v1/notifications/self", body)
        }

        "list_posts" => {
            let path = match arg_str(args, "cursor") {
                Some(c) => format!("/api/v1/posts?cursor={}", urlencode(&c)),
                None => "/api/v1/posts".to_string(),
            };
            api_get(cfg, &path)
        }

        "get_post" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            api_get(cfg, &format!("/api/v1/posts/{}", urlencode(&id)))
        }

        "create_post" => {
            let kind = arg_str(args, "kind").ok_or("kind is required")?;
            let body_md = arg_str(args, "body").ok_or("body is required")?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "posts:write", api_get(cfg, "/api/v1/posts"));
            }
            let mut body = json!({ "kind": kind, "body": body_md });
            for key in ["orgId", "audience", "title"] {
                if let Some(v) = arg_str(args, key) {
                    body[key] = json!(v);
                }
            }
            api_post(cfg, "/api/v1/posts", body)
        }

        "comment_post" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let body_md = arg_str(args, "body").ok_or("body is required")?;
            if arg_bool(args, "dryRun") {
                let target = api_get(cfg, &format!("/api/v1/posts/{}", urlencode(&id)));
                return dry_run(cfg, "posts:write", target);
            }
            api_post(cfg, &format!("/api/v1/posts/{}/comments", urlencode(&id)), json!({ "body": body_md }))
        }

        "react_post" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let emoji = arg_str(args, "emoji").ok_or("emoji is required")?;
            let on = args.get("on").and_then(Value::as_bool).unwrap_or(true);
            let path = match arg_str(args, "commentId") {
                Some(c) => format!("/api/v1/posts/{}/comments/{}/reactions", urlencode(&id), urlencode(&c)),
                None => format!("/api/v1/posts/{}/reactions", urlencode(&id)),
            };
            api_post(cfg, &path, json!({ "emoji": emoji, "on": on }))
        }

        "request_doc_review" => {
            let (kind, id) = doc_target(args)?;
            if arg_bool(args, "dryRun") {
                return dry_run(
                    cfg,
                    "docs:write",
                    api_get(cfg, &format!("/api/v1/docs/{kind}/{id}")),
                );
            }
            let mut body = json!({});
            if let Some(n) = arg_str(args, "note") {
                body["note"] = json!(n);
            }
            let d = api_post(
                cfg,
                &format!("/api/v1/docs/{kind}/{id}/review-request"),
                body,
            )?;
            Ok(json!({
                "requested": true,
                "reviewRequestedAt": d.get("reviewRequestedAt"),
                "note": d.get("reviewRequestNote"),
                "maintainer": d.get("maintainerName"),
            }))
        }

        "list_doc_pages" => {
            let (kind, id) = doc_target(args)?;
            let flat = api_get(cfg, &format!("/api/v1/docs/{kind}/{id}/pages"))?;
            Ok(json!({ "pages": build_page_tree(&flat, &kind, &id) }))
        }

        "get_context" => {
            let target = if let Some(space) = arg_str(args, "spaceId") {
                format!("spaceId={}", urlencode(&space))
            } else {
                let repo = match arg_str(args, "repo") {
                    Some(r) => r,
                    None => {
                        let dir = arg_str(args, "path").unwrap_or_else(|| ".".into());
                        let url = git_remote(&dir)?;
                        github_repo_from_remote(&url).ok_or_else(|| {
                            format!("The git remote of {dir} ({url}) is not a GitHub repository. Pass spaceId.")
                        })?
                    }
                };
                format!("repo={}", urlencode(&repo))
            };
            api_get(cfg, &format!("/api/v1/context?{target}"))
        }

        "list_repo_docs" => {
            let space = arg_str(args, "spaceId").ok_or("spaceId is required")?;
            let groups = api_get(cfg, &format!("/api/v1/repo-docs?spaceId={}", urlencode(&space)))?;
            Ok(json!({ "repos": groups }))
        }

        "get_repo_doc" => {
            let id = arg_str(args, "id").ok_or("id is required")?;
            let d = api_get(cfg, &format!("/api/v1/repo-docs/{}", urlencode(&id)))?;
            Ok(repo_doc_view(&d, arg_str(args, "section").as_deref(), arg_bool(args, "full"))?)
        }

        "get_doc_page" => {
            let (kind, id, page) = page_target(args)?;
            let view = api_get(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}"))?;
            let body = page_body(&view);
            if let Some(wanted) = arg_str(args, "section") {
                let sec = find_section(body, &wanted)?;
                return Ok(json!({
                    "pageId": view.get("page").and_then(|p| p.get("id")),
                    "pageBodyHash": view.get("page").and_then(|p| p.get("bodyHash")),
                    "section": sec.heading,
                    "sectionHash": section_hash(body, &sec),
                    "text": &body[sec.start..sec.end],
                }));
            }
            let mut out = page_outline(&view, &kind, &id);
            if arg_bool(args, "full") {
                out["body"] = json!(body);
            }
            Ok(out)
        }

        "create_doc_page" => {
            let (kind, id) = doc_target(args)?;
            let title = arg_str(args, "title").ok_or("title is required")?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "docs:write", api_get(cfg, &format!("/api/v1/docs/{kind}/{id}")));
            }
            let mut body = json!({ "title": title });
            for key in ["parentId", "afterId", "body"] {
                if let Some(v) = arg_str(args, key) {
                    body[key] = json!(v);
                }
            }
            let out = api_post(cfg, &format!("/api/v1/docs/{kind}/{id}/pages"), body)?;
            Ok(short_page_write(&out, &kind, &id))
        }

        "append_doc_page" => {
            let (kind, id, page) = page_target(args)?;
            let text = arg_str(args, "text").ok_or("text is required")?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "docs:write", api_get(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}")));
            }
            let out = api_post(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}/append"), json!({ "text": text }))?;
            Ok(short_page_write(&out, &kind, &id))
        }

        "write_doc_page" => {
            let (kind, id, page) = page_target(args)?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "docs:manage", api_get(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}")));
            }
            let mut body = json!({});
            if let Some(t) = arg_str(args, "title") {
                body["title"] = json!(t);
            }
            if let Some(b) = args.get("body").and_then(|v| v.as_str()) {
                body["body"] = json!(b);
                // El cuerpo sólo se pisa sabiendo qué se leyó: sin el hash, el
                // servidor lo rechaza si la página ya tiene uno.
                if let Some(h) = arg_str(args, "baseHash") {
                    body["baseHash"] = json!(h);
                }
            }
            if body.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                return Err("Nothing to change: send title and/or body".into());
            }
            let out = api_put(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}"), body)?;
            Ok(short_page_conflict(&out).unwrap_or_else(|| short_page_write(&out, &kind, &id)))
        }

        "write_doc_page_section" => {
            let (kind, id, page) = page_target(args)?;
            let wanted = arg_str(args, "section").ok_or("section is required: the heading to rewrite")?;
            let expected = arg_str(args, "sectionHash").ok_or("sectionHash is required: read it with get_doc_page first")?;
            let content = args.get("body").and_then(|v| v.as_str()).ok_or("body is required")?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "docs:manage", api_get(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}")));
            }
            write_page_section(cfg, &kind, &id, &page, &wanted, &expected, content)
        }

        "move_doc_page" => {
            let (kind, id, page) = page_target(args)?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "docs:manage", api_get(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}")));
            }
            // `parentId` ausente o vacío = colgar de la portada.
            let mut body = json!({ "parentId": Value::Null });
            if let Some(p) = arg_str(args, "parentId").filter(|p| !p.is_empty()) {
                body["parentId"] = json!(p);
            }
            for key in ["afterId", "beforeId"] {
                if let Some(v) = arg_str(args, key) {
                    body[key] = json!(v);
                }
            }
            let flat = api_post(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}/move"), body)?;
            Ok(json!({ "moved": true, "pages": build_page_tree(&flat, &kind, &id) }))
        }

        "delete_doc_page" => {
            let (kind, id, page) = page_target(args)?;
            if arg_bool(args, "dryRun") {
                return dry_run(cfg, "docs:manage", api_get(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}")));
            }
            let out = api_delete(cfg, &format!("/api/v1/docs/{kind}/{id}/pages/{page}"))?;
            Ok(json!({
                "trashed": true,
                "pages": out.get("pages"),
                "note": "The page and its subpages went to the trash. A person can restore them from the app.",
            }))
        }

        "update_doc" => {
            let (kind, id) = doc_target(args)?;
            if arg_bool(args, "dryRun") {
                return dry_run(
                    cfg,
                    "docs:manage",
                    api_get(cfg, &format!("/api/v1/docs/{kind}/{id}")),
                );
            }
            let mut body = json!({});
            // `arg_str` sobre una cadena vacía la devuelve tal cual, y eso importa:
            // vacío significa «quítalo», que es la única forma de dejar un
            // documento sin dueño o de retirar la línea del tablero.
            if let Some(o) = arg_str(args, "owner") {
                body["maintainer"] = json!(o);
            }
            if let Some(l) = arg_str(args, "pinnedLine") {
                body["pinnedLine"] = json!(l);
            }
            if body.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                return Err("Nothing to change: send owner and/or pinnedLine".into());
            }
            api_patch(cfg, &format!("/api/v1/docs/{kind}/{id}"), body)
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
    let tasks = data
        .get("tasks")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

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
                        // El checklist de la tarea. El tablero no lista las
                        // subtareas, así que sin esto no había ninguna pista de
                        // que una tarjeta tuviera uno — y un agente acababa
                        // apuntando pendientes en comentarios (#90).
                        "subtasks": subtask_progress(t),
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
                col["truncated"] = json!(format!(
                    "showing {shown} of {total}; raise limit to see more"
                ));
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

/// `"2/5"` si la tarjeta tiene subtareas, y nada si no: un `"0/0"` en cada
/// tarjeta sería ruido en la mayoría, que no tienen checklist.
fn subtask_progress(card: &Value) -> Value {
    let n = |k: &str| card.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    match n("subtaskCount") {
        0 => Value::Null,
        total => json!(format!("{}/{}", n("subtaskDone"), total)),
    }
}

/// Milisegundos desde la época, ahora.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lo que un agente escribe para «desde cuándo»: `30m`, `6h`, `2d` (hacia
/// atrás desde `now`, en milisegundos), milisegundos tal cual, o una fecha ISO
/// que pasa sin tocar — la valida el backend, que contesta 400 si no lo es.
/// Lo que no se parece a ninguna de las tres se rechaza aquí, con un mensaje
/// que dice qué se acepta.
fn parse_when(v: &str, now: i64) -> Option<String> {
    let v = v.trim();
    if let Ok(ms) = v.parse::<i64>() {
        return Some(ms.to_string());
    }
    let unit = match v.chars().last()? {
        'm' => 60_000,
        'h' => 3_600_000,
        'd' => 86_400_000,
        _ => 0,
    };
    if unit > 0 {
        if let Ok(n) = v[..v.len() - 1].parse::<i64>() {
            return Some((now - n * unit).to_string());
        }
    }
    let b = v.as_bytes();
    let iso = b.len() >= 10 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-';
    iso.then(|| v.to_string())
}

/// La lista de dispositivos, con lo que sirve para elegir uno y nada más. El
/// cursor de la siguiente página, si la hay, va en la última fila: se saca.
fn compact_devices(data: &Value) -> Value {
    let empty = vec![];
    let rows = data.as_array().unwrap_or(&empty);
    let next = rows.last().and_then(|r| r.get("cursor")).cloned().unwrap_or(Value::Null);
    let devices: Vec<Value> = rows
        .iter()
        .map(|d| {
            json!({
                "deviceId": d.get("deviceId"),
                "projectId": d.get("projectId"),
                "project": d.get("projectName"),
                "label": d.get("label"),
                "subject": d.get("subject"),
                "platform": d.get("platform"),
                "appVersion": d.get("appVersion"),
                "lastSeen": d.get("lastSeen"),
                "lastHeartbeatAt": d.get("lastHeartbeatAt"),
                "silentSince": d.get("silentSince"),
                "errors": d.get("errorCount"),
                "warnings": d.get("warnCount"),
                "alerts": d.get("alerts"),
            })
        })
        .collect();
    json!({ "devices": devices, "nextCursor": next })
}

/// A qué proyecto manda un dispositivo, cuando no lo dicen. Si manda a más de
/// uno hay que decirlo: mezclar sus timelines es justo lo que no se quiere.
fn resolve_device_project(cfg: &Cfg, device: &str) -> Result<String, String> {
    let data = api_get(cfg, &format!("/api/v1/telemetry/devices?q={}", urlencode(device)))?;
    pick_project(&data, device)
}

fn pick_project(data: &Value, device: &str) -> Result<String, String> {
    let empty = vec![];
    let hits: Vec<&Value> = data
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|d| d.get("deviceId").and_then(|v| v.as_str()) == Some(device))
        .collect();
    match hits.as_slice() {
        [] => Err(format!("no telemetry from device {device}")),
        [one] => one
            .get("projectId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "device without project".to_string()),
        many => Err(format!(
            "device {device} sends to {} projects; pass projectId: {}",
            many.len(),
            many.iter()
                .map(|d| format!(
                    "{} ({})",
                    d.get("projectId").and_then(|v| v.as_str()).unwrap_or("?"),
                    d.get("projectName").and_then(|v| v.as_str()).unwrap_or("?")
                ))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// Las hojas de un JSON como `ruta → valor`, para leer una ficha de un vistazo
/// sin el anidamiento. Con tope: una ficha enorme no puede llenar el contexto.
fn flatten_leaves(v: &Value, prefix: &str, out: &mut serde_json::Map<String, Value>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    match v {
        Value::Object(m) => {
            for (k, child) in m {
                let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                flatten_leaves(child, &path, out, cap);
            }
        }
        _ if !prefix.is_empty() => {
            out.insert(prefix.to_string(), v.clone());
        }
        _ => {}
    }
}

const SHEET_CAP: usize = 150;

/// Compact a raw timeline so it fits a model's context: the device sheet once
/// (flattened, with the project's alerts and the heartbeat gaps), errors and
/// warnings verbatim — with the severity the **server** decided, the same the
/// app paints — successful network calls collapsed into per-endpoint counts,
/// and heartbeats with their content instead of just a count.
fn summarize_timeline(data: &Value, detail: &Value) -> Value {
    let empty = vec![];
    let batches = data.as_array().unwrap_or(&empty);

    let mut errors: Vec<Value> = vec![];
    let mut warnings: Vec<Value> = vec![];
    let mut beats: Vec<Value> = vec![];
    let mut net: std::collections::BTreeMap<String, i64> = Default::default();
    let mut other: std::collections::BTreeMap<String, i64> = Default::default();
    let mut fallback_device: Option<Value> = None;
    let (mut req_total, mut err_total, mut warn_total) = (0i64, 0i64, 0i64);
    let (mut first_seen, mut last_seen) = (None::<String>, None::<String>);
    let mut undecryptable = 0;

    for b in batches {
        if fallback_device.is_none() {
            if let Some(d) = b.get("device").filter(|d| !d.is_null()) {
                fallback_device = Some(d.clone());
            }
        }
        if b.get("undecryptable").and_then(|v| v.as_bool()).unwrap_or(false) {
            undecryptable += 1;
        }
        req_total += b.get("reqCount").and_then(|v| v.as_i64()).unwrap_or(0);
        err_total += b.get("errorCount").and_then(|v| v.as_i64()).unwrap_or(0);
        warn_total += b.get("warnCount").and_then(|v| v.as_i64()).unwrap_or(0);
        if let Some(ts) = b.get("receivedAt").and_then(|v| v.as_str()) {
            if last_seen.is_none() {
                last_seen = Some(ts.to_string()); // newest first from the API
            }
            first_seen = Some(ts.to_string());
        }
        let sevs = b.get("severities").and_then(|v| v.as_array()).unwrap_or(&empty);

        for (i, c) in b
            .get("breadcrumbs")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty)
            .iter()
            .enumerate()
        {
            let ctype = c.get("type").and_then(|v| v.as_str()).unwrap_or("log");
            let severity = sevs.get(i).and_then(|v| v.as_str()).unwrap_or("info");
            match severity {
                "error" => {
                    if errors.len() < 60 {
                        errors.push(c.clone());
                    }
                    continue;
                }
                "warn" => {
                    if warnings.len() < 60 {
                        warnings.push(c.clone());
                    }
                    continue;
                }
                _ => {}
            }
            if ctype == "heartbeat" {
                if beats.len() < 30 {
                    beats.push(c.clone());
                }
                continue;
            }
            if matches!(ctype, "network" | "request" | "fetch" | "xhr") {
                let key = format!(
                    "{} {} → {}",
                    c.get("method").and_then(|v| v.as_str()).unwrap_or("?"),
                    c.get("url").and_then(|v| v.as_str()).unwrap_or("?"),
                    c.get("status").and_then(|v| v.as_i64()).unwrap_or(0)
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

    // La ficha: la del backend (la última guardada), o la del lote más nuevo.
    let sheet_src = detail
        .get("device")
        .filter(|d| !d.is_null())
        .cloned()
        .or(fallback_device);
    let mut sheet = serde_json::Map::new();
    if let Some(d) = &sheet_src {
        flatten_leaves(d, "", &mut sheet, SHEET_CAP);
    }
    let gaps = detail.get("gaps").cloned().unwrap_or(json!([]));
    let heartbeat_times = detail.get("heartbeats").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);

    json!({
        "device": {
            "deviceId": detail.get("deviceId"),
            "project": detail.get("projectName"),
            "label": detail.get("label"),
            "subject": detail.get("subject"),
            "platform": detail.get("platform"),
            "appVersion": detail.get("appVersion"),
            "lastSeen": detail.get("lastSeen"),
            "lastHeartbeatAt": detail.get("lastHeartbeatAt"),
            "silentSince": detail.get("silentSince"),
            "unhealthySince": detail.get("unhealthySince"),
            "alerts": detail.get("alerts").cloned().unwrap_or(json!([])),
            "state": sheet,
        },
        "heartbeats": {
            "expected": detail.get("heartbeat"),
            "storedCount": heartbeat_times,
            "gaps": gaps,
            "recent": beats,
        },
        "summary": {
            "batches": batches.len(),
            "requests": req_total,
            "errors": err_total,
            "warnings": warn_total,
            "undecryptableBatches": undecryptable,
            "from": first_seen,
            "to": last_seen,
        },
        "errors": errors,
        "warnings": warnings,
        "networkByEndpoint": net,
        "events": other,
        "note": "Severity comes from the server (same as the app). Errors and warnings are verbatim; successful traffic is grouped by endpoint+status; device.state is the latest stored state, flattened. Raise `limit` or narrow with since/types/minSeverity."
    })
}

#[cfg(test)]
mod telemetry_tests {
    use super::*;

    fn batch(severities: Value, crumbs: Value) -> Value {
        json!({ "receivedAt": "2026-10-07T10:00:00Z", "reqCount": 1, "errorCount": 1, "warnCount": 1,
                "breadcrumbs": crumbs, "severities": severities, "device": { "fallback": true } })
    }

    #[test]
    fn the_severity_is_the_servers() {
        // Un `request` 500 es error y un lifecycle `warn` es aviso, porque lo
        // dice el servidor; antes el MCP tenía su propia regla y no contaba
        // `request` como error.
        let data = json!([batch(
            json!(["error", "warn", "info", "info"]),
            json!([
                { "type": "request", "status": 500, "url": "/a" },
                { "type": "lifecycle", "name": "DEVICE_NETWORK_CHANGED", "level": "warn" },
                { "type": "network", "method": "POST", "url": "/b", "status": 200 },
                { "type": "heartbeat", "counts": { "accepted": 12 }, "trackingActive": true }
            ])
        )]);
        let out = summarize_timeline(&data, &Value::Null);
        assert_eq!(out["errors"].as_array().unwrap().len(), 1);
        assert_eq!(out["errors"][0]["url"], "/a");
        assert_eq!(out["warnings"][0]["name"], "DEVICE_NETWORK_CHANGED");
        assert_eq!(out["networkByEndpoint"]["POST /b → 200"], 1);
        // El latido llega con su contenido, no como un contador.
        assert_eq!(out["heartbeats"]["recent"][0]["counts"]["accepted"], 12);
        assert!(out["events"].as_object().unwrap().is_empty());
        assert_eq!(out["summary"]["warnings"], 1);
    }

    #[test]
    fn the_sheet_is_the_stored_one_flattened_with_its_alerts() {
        let detail = json!({
            "deviceId": "d1", "label": "Moto G", "subject": "E-104", "projectName": "GEOCHECK",
            "device": { "snapshot": { "battery": { "optimizationEnabled": true }, "tracking": { "lastCallbackAgeSeconds": 905 } } },
            "alerts": [{ "path": "snapshot.tracking.lastCallbackAgeSeconds", "severity": "error", "message": "Rastreo parado" }],
            "heartbeats": ["2026-10-07T10:00:00Z"],
            "gaps": [{ "from": "2026-10-07T10:00:00Z", "to": "2026-10-07T12:00:00Z", "seconds": 7200, "open": true }],
        });
        let out = summarize_timeline(&json!([batch(json!([]), json!([]))]), &detail);
        let state = &out["device"]["state"];
        assert_eq!(state["snapshot.tracking.lastCallbackAgeSeconds"], 905);
        assert_eq!(state["snapshot.battery.optimizationEnabled"], true);
        assert!(state.get("fallback").is_none(), "used the batch's device instead of the stored sheet");
        assert_eq!(out["device"]["alerts"][0]["message"], "Rastreo parado");
        assert_eq!(out["device"]["label"], "Moto G");
        assert_eq!(out["heartbeats"]["gaps"][0]["open"], true);
        assert_eq!(out["heartbeats"]["storedCount"], 1);
    }

    #[test]
    fn without_a_sheet_the_newest_batch_device_is_used() {
        let out = summarize_timeline(&json!([batch(json!([]), json!([]))]), &Value::Null);
        assert_eq!(out["device"]["state"]["fallback"], true);
    }

    #[test]
    fn a_huge_sheet_is_capped() {
        let mut big = serde_json::Map::new();
        for i in 0..500 {
            big.insert(format!("k{i}"), json!(i));
        }
        let mut out = serde_json::Map::new();
        flatten_leaves(&Value::Object(big), "", &mut out, SHEET_CAP);
        assert_eq!(out.len(), SHEET_CAP);
    }

    #[test]
    fn when_is_relative_epoch_or_iso() {
        let now = 1_000_000_000_000;
        let ms = |n: i64| Some(n.to_string());
        assert_eq!(parse_when("30m", now), ms(now - 30 * 60_000));
        assert_eq!(parse_when("6h", now), ms(now - 6 * 3_600_000));
        assert_eq!(parse_when("2d", now), ms(now - 2 * 86_400_000));
        assert_eq!(parse_when("1696600000000", now), ms(1_696_600_000_000));
        assert_eq!(parse_when("2026-10-07T12:00:00Z", now).as_deref(), Some("2026-10-07T12:00:00Z"));
        assert_eq!(parse_when("ayer", now), None);
        assert_eq!(parse_when("5x", now), None);
    }

    #[test]
    fn the_device_list_is_compact_and_brings_out_the_cursor() {
        let out = compact_devices(&json!([
            { "deviceId": "a", "projectName": "GEO", "label": "Moto", "subject": "E-1", "errorCount": 2, "warnCount": 1, "snapshot": "no" },
            { "deviceId": "b", "cursor": "NEXT" }
        ]));
        assert_eq!(out["nextCursor"], "NEXT");
        assert_eq!(out["devices"][0]["project"], "GEO");
        assert_eq!(out["devices"][0]["warnings"], 1);
        assert!(out["devices"][0].get("cursor").is_none());
        assert_eq!(compact_devices(&json!([{ "deviceId": "a" }]))["nextCursor"], Value::Null);
    }

    #[test]
    fn a_device_in_two_projects_must_say_which() {
        let two = json!([
            { "deviceId": "d", "projectId": "p1", "projectName": "A" },
            { "deviceId": "d", "projectId": "p2", "projectName": "B" },
            { "deviceId": "d-other", "projectId": "p3" }
        ]);
        let err = pick_project(&two, "d").unwrap_err();
        assert!(err.contains("p1 (A)") && err.contains("p2 (B)"), "{err}");
        assert_eq!(pick_project(&json!([{ "deviceId": "d", "projectId": "p1" }, { "deviceId": "dd", "projectId": "p9" }]), "d").unwrap(), "p1");
        assert!(pick_project(&json!([]), "d").is_err());
    }
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
                "serverInfo": { "name": "cac", "version": env!("CARGO_PKG_VERSION") },
                "instructions": instructions(skills_dir().as_deref().map(skill_state))
            }),
        )),
        "ping" => Some(ok(id, json!({}))),
        "tools/list" => Some(ok(id, json!({ "tools": tool_defs() }))),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            // A tool that never calls cac must work without a token. Every
            // other one needs the config, so the check stays where it was.
            let res = if LOCAL_TOOLS.contains(&name) {
                call_local_tool(name, &args)
            } else {
                match cfg {
                    Ok(c) => call_tool(c, name, &args),
                    Err(e) => Err(e.clone()),
                }
            };
            Some(ok(id, tool_result(res)))
        }
        other => Some(err(id, -32601, format!("method not found: {other}"))),
    }
}

/// Tools that run entirely on this machine and never call cac, so they work
/// with no token configured at all.
const LOCAL_TOOLS: &[&str] = &["compress_image", "install_skill"];

/// Las líneas de la checklist de `create_task` (`subtasks`), o `None`. Un
/// título vacío o más de 30 líneas es un error antes de crear nada.
fn subtask_titles(args: &Value) -> Result<Option<Vec<String>>, String> {
    let Some(v) = args.get("subtasks") else {
        return Ok(None);
    };
    let arr = v.as_array().ok_or("subtasks must be a list of titles")?;
    if arr.len() > 30 {
        return Err("At most 30 subtasks at once".into());
    }
    let mut out = vec![];
    for x in arr {
        let t = x.as_str().map(str::trim).unwrap_or("");
        if t.is_empty() {
            return Err("Every subtask needs a title".into());
        }
        out.push(t.to_string());
    }
    Ok(if out.is_empty() { None } else { Some(out) })
}

/// La clave de idempotencia de la subtarea `i`, derivada de la del padre.
fn subtask_key(parent_key: &str, i: usize) -> String {
    format!("{parent_key}/sub-{i}")
}

/// La columna a la que mover en `update_task`: `statusId` (del tablero) o
/// `status` por nombre, que el backend resuelve en la lista de la tarea
/// (`domain.MoveStatusID`). Los dos a la vez es un error: no se sabe cuál vale.
fn move_target(args: &Value) -> Result<Option<String>, String> {
    let id = arg_str(args, "statusId");
    let named = arg_str(args, "status");
    match (id, named) {
        (Some(_), Some(_)) => Err("Send status or statusId, not both".into()),
        (Some(id), None) => Ok(Some(id)),
        (None, Some(n)) => match n.as_str() {
            "open" | "in_progress" | "done" | "closed" => Ok(Some(n)),
            other => Err(format!("Unknown status \"{other}\": use open, in_progress, done or closed")),
        },
        (None, None) => Ok(None),
    }
}

/// La URL del remote `origin` del repo en `dir` (o del primero que haya).
fn git_remote(dir: &str) -> Result<String, String> {
    let run = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    if let Some(url) = run(&["remote", "get-url", "origin"]) {
        return Ok(url);
    }
    let first = run(&["remote"]).and_then(|r| r.lines().next().map(str::to_string));
    first
        .and_then(|name| run(&["remote", "get-url", &name]))
        .ok_or_else(|| format!("{dir} is not a git repository with a remote. Pass spaceId or repo."))
}

/// `owner/name` de un remote de GitHub, en cualquiera de sus formas:
/// `git@github.com:o/n.git`, `https://github.com/o/n`, `ssh://git@github.com/o/n.git`,
/// con usuario o token delante del host. `None` si no es de GitHub.
fn github_repo_from_remote(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = if let Some(i) = u.find("github.com:") {
        &u[i + "github.com:".len()..]
    } else if let Some(i) = u.find("github.com/") {
        &u[i + "github.com/".len()..]
    } else {
        return None;
    };
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    if owner.is_empty() || name.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

/// La skill de trabajar con cac (leer el contexto, registrar la tarea, dejar
/// escrito lo decidido), dentro del binario.
///
/// Viaja con el MCP para que quien conecta cac a Claude Code la tenga sin
/// buscarla: el MCP ya está en cada máquina del equipo, la skill no. jose tenía
/// que recordarle a cada sesión que registrara y actualizara sus tareas
/// (21-oct-2026); las instrucciones de abajo lo dicen siempre, y la skill dice
/// cómo.
const WORK_SKILL: &str = include_str!("../skills/cac-work/SKILL.md");
const WORK_SKILL_NAME: &str = "cac-work";

/// La versión de una copia de la skill, de su marca final `<!-- cac-work vN -->`.
/// Se sube a mano al cambiar la skill: es lo que hace que se ofrezca actualizar.
fn skill_version(text: &str) -> Option<u32> {
    let tail = text.rsplit("<!-- cac-work v").next()?;
    if tail.len() == text.len() {
        return None;
    }
    tail.split_whitespace().next()?.parse().ok()
}

#[derive(Debug, PartialEq)]
enum SkillState {
    Missing,
    Outdated,
    Current,
}

/// Dónde busca Claude Code las skills de la persona: `CLAUDE_CONFIG_DIR` si
/// está puesta (el MCP la hereda de Claude Code), y si no `~/.claude`.
fn skills_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".claude")))?;
    Some(base.join("skills"))
}

fn skill_state(dir: &std::path::Path) -> SkillState {
    let Ok(text) = std::fs::read_to_string(dir.join(WORK_SKILL_NAME).join("SKILL.md")) else {
        return SkillState::Missing;
    };
    // Una copia sin marca o más vieja se ofrece actualizar; una más nueva (de
    // una app más reciente en otra parte) se deja como está.
    match (skill_version(&text), skill_version(WORK_SKILL)) {
        (Some(have), Some(ship)) if have >= ship => SkillState::Current,
        _ => SkillState::Outdated,
    }
}

/// Lo que el MCP le dice al agente al conectarse. Claude Code lo pone en el
/// contexto de toda la sesión, así que llega aunque nadie cargue la skill: es
/// el recordatorio que antes tenía que hacer jose a mano.
fn instructions(state: Option<SkillState>) -> String {
    let mut s = String::from(
        "cac is this team's shared memory: what one session learns is lost when it ends, and what is written in cac \
         is what the next session, or any teammate, can read. When you start work in a repository, call get_context \
         first (no arguments: it finds the project from the folder's git remote). It returns the index of what the team \
         knows (the tree, the headings of each document, decisions, repo docs, tasks in progress) without bodies; then \
         read only the sections you need with get_doc (tab + section), and use search for anything else. If the repo \
         is not linked to a space, the repository's CLAUDE.md may name its list under \"Tareas en cac\"; otherwise ask \
         the user. Find or create the task and move it to in progress. Record findings as task comments and decisions \
         with record_decision. Before you tell the user you are done, update the task: its column must say honestly \
         how the work stands, with a short closing comment (what was done, commits or PR, what is left).",
    );
    match state {
        Some(SkillState::Missing) => s.push_str(
            "\n\nThe cac-work skill, which explains all this step by step, is not installed on this machine. At a natural \
             pause early in the session, suggest installing it to the user in one sentence; if they agree, call \
             install_skill. Do not install it without asking, and do not bring it up again if they decline.",
        ),
        Some(SkillState::Outdated) => s.push_str(
            "\n\nThe installed cac-work skill is older than the one this cac app ships. At a natural pause, offer the \
             user to update it in one sentence; if they agree, call install_skill.",
        ),
        _ => {}
    }
    s
}

/// Escribe la skill en `dir`. No pisa una copia más nueva.
fn install_skill(dir: &std::path::Path, dry_run: bool) -> Result<Value, String> {
    let path = dir.join(WORK_SKILL_NAME).join("SKILL.md");
    let before = std::fs::read_to_string(&path).ok();
    let had = before.as_deref().and_then(skill_version);
    let ship = skill_version(WORK_SKILL);
    if let (Some(h), Some(v)) = (had, ship) {
        if h > v {
            return Err(format!(
                "{} already has v{h}, newer than the v{v} this app ships; left as it is.",
                path.display()
            ));
        }
    }
    let result = json!({
        "path": path.display().to_string(),
        "version": ship,
        "replaced": before.is_some(),
        "previousVersion": had,
    });
    if dry_run {
        return Ok(json!({ "wouldWrite": result, "dryRun": true }));
    }
    std::fs::create_dir_all(path.parent().unwrap_or(dir))
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    std::fs::write(&path, WORK_SKILL).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(result)
}

fn call_local_tool(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        // Escribe un fichero fijo y conocido, con el texto que va dentro del
        // binario: ni la ruta ni el contenido los elige quien llama.
        "install_skill" => {
            let dir = skills_dir().ok_or("Could not find the Claude Code config folder (no HOME).")?;
            install_skill(&dir, arg_bool(args, "dryRun"))
        }
        // The only tool here that is not an HTTP call. The MCP server *is* the
        // app binary, so the compressor the image page uses is already linked
        // in — there is no endpoint to add and nothing leaves the machine.
        //
        // Paths in and out, never base64: a 2 MB screenshot is ~2.7 MB of text,
        // and an agent that converts a folder would spend its whole context on
        // bytes it never reads.
        "compress_image" => {
            let path = arg_str(args, "path").ok_or("path is required")?;
            let format = arg_str(args, "format").unwrap_or_else(|| "webp".into());
            let fmt: crate::image::OutputFormat = serde_json::from_value(json!(format))
                .map_err(|e| format!("Invalid format: {e}"))?;

            let out_path = arg_str(args, "outPath").unwrap_or_else(|| {
                let p = std::path::Path::new(&path);
                p.with_extension(fmt.extension())
                    .to_string_lossy()
                    .into_owned()
            });

            let quality = arg_i64(args, "quality").map(|q| q.clamp(1, 100) as u8);
            let max_width = arg_i64(args, "maxWidth")
                .filter(|w| *w > 0)
                .map(|w| w as u32);

            if arg_bool(args, "dryRun") {
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                return Ok(json!({
                    "wouldRead": path,
                    "wouldWrite": out_path,
                    "format": fmt.extension(),
                    "originalBytes": size,
                    "dryRun": true,
                }));
            }

            let raw = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
            let opts = crate::image::CompressOptions {
                quality,
                max_width,
                format: fmt,
            };
            let result = crate::image::compress(&raw, &opts)?;
            std::fs::write(&out_path, &result.data)
                .map_err(|e| format!("Could not write {out_path}: {e}"))?;

            let saved = result
                .original_bytes
                .saturating_sub(result.compressed_bytes);
            Ok(json!({
                "path": out_path,
                "format": result.format,
                "width": result.width,
                "height": result.height,
                "originalBytes": result.original_bytes,
                "bytes": result.compressed_bytes,
                "savedPercent": if result.original_bytes > 0 {
                    (saved as f64 / result.original_bytes as f64 * 100.0).round()
                } else { 0.0 },
            }))
        }

        other => Err(format!("unknown tool: {other}")),
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

// ─── Pruebas ─────────────────────────────────────────────────────────────────
//
// Las primeras de este fichero. Van sobre lo que decide qué se le manda al
// backend, que es donde vive la cicatriz que cuentan sus comentarios: un
// argumento que la herramienta acepta y luego se pierde por el camino.
#[cfg(test)]
mod tests {
    use super::*;

    // ── Vencimientos ────────────────────────────────────────────────────────

    /// El día elegido a medianoche UTC, como lo guarda la app. El mutante que
    /// mata: mandar la fecha sin la hora, o con otra zona.
    #[test]
    fn a_due_date_is_that_day_at_utc_midnight() {
        assert_eq!(
            due_date_to_instant("2026-09-30").unwrap(),
            "2026-09-30T00:00:00Z"
        );
    }

    /// Un día que no existe se rechaza, no se desborda al mes siguiente.
    #[test]
    fn an_impossible_date_is_refused() {
        for bad in [
            "2026-09-31",
            "2026-02-29",
            "2026-13-01",
            "2026-00-10",
            "2026-09-00",
        ] {
            assert!(
                due_date_to_instant(bad).is_err(),
                "{bad} debería rechazarse"
            );
        }
        assert!(
            due_date_to_instant("2028-02-29").is_ok(),
            "2028 es bisiesto"
        );
        assert!(
            due_date_to_instant("2000-02-29").is_ok(),
            "2000 es bisiesto"
        );
        assert!(due_date_to_instant("2100-02-29").is_err(), "2100 no lo es");
    }

    /// Y lo que no es una fecha —una hora local, otro formato— también: es
    /// justo lo que dejaría pasar la zona que esto existe para quitar.
    #[test]
    fn only_a_plain_date_is_accepted() {
        for bad in [
            "2026-09-30T23:00:00-06:00",
            "30/09/2026",
            "2026-9-30",
            "mañana",
            "",
        ] {
            assert!(
                due_date_to_instant(bad).is_err(),
                "«{bad}» debería rechazarse"
            );
        }
    }

    // ── Nombres a ids ───────────────────────────────────────────────────────

    fn tags() -> Vec<(String, String)> {
        vec![("bug".into(), "t-1".into()), ("UX".into(), "t-2".into())]
    }

    #[test]
    fn names_resolve_without_caring_about_case() {
        let ids = resolve_names(&["BUG".into(), "ux".into()], &tags(), "tag").unwrap();
        assert_eq!(ids, vec!["t-1", "t-2"]);
    }

    /// El que importa: un nombre que no existe falla, y dice cuáles sí. El
    /// mutante que mata: saltarse los que no casan, que es la cicatriz.
    #[test]
    fn an_unknown_name_fails_and_says_what_exists() {
        let e = resolve_names(&["bug".into(), "urgente".into()], &tags(), "tag").unwrap_err();
        assert!(e.contains("urgente"), "tiene que nombrar el que falta: {e}");
        assert!(
            e.contains("UX") && e.contains("bug"),
            "y ofrecer los que hay: {e}"
        );
    }

    #[test]
    fn the_same_name_twice_is_one_id() {
        let ids = resolve_names(&["bug".into(), "Bug".into()], &tags(), "tag").unwrap();
        assert_eq!(ids, vec!["t-1"]);
    }

    // ── De qué organización es una lista ────────────────────────────────────

    #[test]
    fn a_list_is_found_wherever_it_hangs() {
        let tree = json!([
            { "orgId": "org-a", "lists": [{ "id": "suelta" }], "folders": [
                { "lists": [{ "id": "en-carpeta" }], "folders": [
                    { "lists": [{ "id": "anidada" }] }
                ]}
            ]},
            { "orgId": "org-b", "lists": [{ "id": "de-otra" }] }
        ]);
        assert_eq!(org_of_list(&tree, "suelta").as_deref(), Some("org-a"));
        assert_eq!(org_of_list(&tree, "en-carpeta").as_deref(), Some("org-a"));
        assert_eq!(org_of_list(&tree, "anidada").as_deref(), Some("org-a"));
        assert_eq!(org_of_list(&tree, "de-otra").as_deref(), Some("org-b"));
        assert_eq!(org_of_list(&tree, "no-existe"), None);
    }

    // ── El checklist ────────────────────────────────────────────────────────

    /// Una tarjeta con subtareas dice cuántas lleva; una sin ellas, nada.
    #[test]
    fn a_card_says_how_far_its_checklist_is() {
        assert_eq!(
            subtask_progress(&json!({ "subtaskCount": 5, "subtaskDone": 2 })),
            json!("2/5")
        );
        assert_eq!(
            subtask_progress(&json!({ "subtaskCount": 0, "subtaskDone": 0 })),
            Value::Null
        );
        assert_eq!(subtask_progress(&json!({})), Value::Null);
    }

    /// Y el tablero lo lleva. El mutante que mata: quitar el campo del resumen.
    #[test]
    fn the_board_summary_carries_the_checklist() {
        let board = json!({
            "list": { "name": "L" },
            "statuses": [{ "id": "s", "name": "Open", "kind": "open" }],
            "tasks": [{ "id": "t", "statusId": "s", "subtaskCount": 3, "subtaskDone": 1 }]
        });
        let out = summarize_board(&board, 10);
        assert_eq!(out["columns"][0]["tasks"][0]["subtasks"], json!("1/3"));
    }

    // ── Búsqueda ────────────────────────────────────────────────────────────

    /// Menos de dos caracteres es un error, no un «no hay nada».
    #[test]
    fn a_search_too_short_is_an_error_not_an_empty_answer() {
        assert!(search_query(&json!({ "query": "a" })).is_err());
        assert!(search_query(&json!({})).is_err());
    }

    /// Un límite de más se recorta a 20: el servidor lo devolvería a 8.
    #[test]
    fn a_search_limit_is_clamped_not_reset() {
        let q = search_query(&json!({ "query": "koa", "limit": 50, "orgId": "o 1" })).unwrap();
        assert!(q.contains("q=koa"), "{q}");
        assert!(q.contains("limit=20"), "{q}");
        assert!(q.contains("orgId=o%201"), "{q}");
    }

    /// Del chat no sale nada por aquí. El mutante que mata: devolver la
    /// respuesta del servidor entera.
    #[test]
    fn search_never_hands_out_chat() {
        let out = search_results(&json!({
            "tasks": [1], "notes": [2], "docs": [3],
            "messages": ["x"], "dms": ["y"], "people": ["z"]
        }));
        assert_eq!(out, json!({ "tasks": [1], "notes": [2], "docs": [3] }));
    }

    // ── Decisiones ──────────────────────────────────────────────────────────

    #[test]
    fn a_decision_comes_from_the_doc_unless_it_names_a_task() {
        let doc = decision_body("t", &json!({ "body": "porque sí" }));
        assert_eq!(doc["origin"], "doc");
        assert!(doc.get("originTaskId").is_none());

        let task = decision_body("t", &json!({ "originTaskId": "task-9" }));
        assert_eq!(task["origin"], "task");
        assert_eq!(task["originTaskId"], "task-9");
    }

    // ── Documentos por sección ──────────────────────────────────────────────

    const RUNBOOK: &str = "# Runbook\n\nIntro.\n\n## Correo\n\nSMTP por Brevo.\n\n```bash\n# esto es un comentario, no un titulo\necho hola\n```\n\n### Puertos\n\n587.\n\n## Despliegue\n\nCon Actions.\n";

    #[test]
    fn sections_follow_heading_levels() {
        let s = sections(RUNBOOK);
        let names: Vec<&str> = s.iter().map(|x| x.heading.as_str()).collect();
        assert_eq!(names, vec!["Runbook", "Correo", "Puertos", "Despliegue"]);
        let correo = &s[1];
        let text = &RUNBOOK[correo.start..correo.end];
        // «Correo» incluye su subsección «Puertos» y acaba donde empieza «Despliegue».
        assert!(
            text.contains("### Puertos") && text.contains("587."),
            "{text}"
        );
        assert!(!text.contains("Despliegue"), "{text}");
    }

    /// El que más daño haría: un `#` de un comentario de bash tomado por título
    /// partiría el runbook a mitad de un comando. El mutante que mata: dejar de
    /// seguir los bloques de código.
    #[test]
    fn a_hash_inside_a_code_block_is_not_a_heading() {
        assert!(sections(RUNBOOK)
            .iter()
            .all(|x| !x.heading.contains("comentario")));
    }

    #[test]
    fn a_hashtag_is_not_a_heading() {
        assert!(sections("#etiqueta suelta\n\ntexto\n").is_empty());
    }

    #[test]
    fn a_section_is_found_with_or_without_its_hashes() {
        for w in ["Correo", "correo", "## Correo", "  ##  Correo "] {
            assert_eq!(find_section(RUNBOOK, w).unwrap().heading, "Correo", "{w}");
        }
    }

    #[test]
    fn a_missing_section_says_which_ones_exist() {
        let e = find_section(RUNBOOK, "Backups").unwrap_err();
        assert!(
            e.contains("Backups") && e.contains("## Correo") && e.contains("## Despliegue"),
            "{e}"
        );
    }

    /// Dos «## Correo» no dicen cuál se quiere reescribir: adivinarlo borraría
    /// el equivocado. El mutante que mata: quedarse con el primero.
    #[test]
    fn a_heading_that_appears_twice_is_refused() {
        let doble = "## Correo\n\nuno\n\n## Correo\n\ndos\n";
        assert!(find_section(doble, "Correo")
            .unwrap_err()
            .contains("2 sections"));
    }

    /// Reescribir una sección deja su título, lo que va antes y lo que va
    /// después tal cual.
    #[test]
    fn splicing_a_section_keeps_everything_else() {
        let sec = find_section(RUNBOOK, "Despliegue").unwrap();
        let out = splice_section(RUNBOOK, &sec, "Con Actions y un paso de prueba.");
        assert!(
            out.ends_with("## Despliegue\n\nCon Actions y un paso de prueba.\n"),
            "{out}"
        );
        assert!(out.starts_with(&RUNBOOK[..sec.start]));
    }

    /// Y lo que sigue no se queda pegado: sin la línea en blanco, el título
    /// siguiente dejaría de leerse como título.
    #[test]
    fn splicing_leaves_the_next_heading_standing() {
        let sec = find_section(RUNBOOK, "Correo").unwrap();
        let out = splice_section(RUNBOOK, &sec, "Ahora por SES.");
        assert!(
            out.contains("## Correo\n\nAhora por SES.\n\n## Despliegue"),
            "{out}"
        );
        assert!(
            !out.contains("587."),
            "la subsección era parte de «Correo» y se reemplaza con ella"
        );
    }

    /// La razón de que haya un hash por sección: editar otra parte de la
    /// pestaña no invalida el tuyo. El mutante que mata: calcularlo sobre la
    /// pestaña entera.
    #[test]
    fn a_section_hash_ignores_the_rest_of_the_tab() {
        let correo = |b: &str| section_hash(b, &find_section(b, "Correo").unwrap());
        let otra = RUNBOOK.replace("Con Actions.", "Con Actions y más.");
        assert_eq!(correo(RUNBOOK), correo(&otra));
        let esta = RUNBOOK.replace("SMTP por Brevo.", "SMTP por SES.");
        assert_ne!(correo(RUNBOOK), correo(&esta));
    }

    fn doc() -> Value {
        json!({
            "doc": { "id": "d", "body": "EL OVERVIEW OTRA VEZ", "maintainerName": "ana" },
            "tabs": [
                { "key": "overview", "body": "# Hola\n\nx\n", "bodyHash": "h-o", "updatedAt": "t1" },
                { "key": "runbook", "body": RUNBOOK, "bodyHash": "h-r", "updatedAt": "t2" }
            ],
            "decisions": [
                { "id": "vieja", "title": "A", "body": "PORQUE LARGO", "decidedAt": "2026-09-01", "createdAt": "2026-09-27T10:00:00Z" },
                { "id": "nueva", "title": "B", "body": "PORQUE", "decidedAt": "2026-08-01", "createdAt": "2026-09-28T10:00:00Z" }
            ],
            "attachments": [{}, {}]
        })
    }

    /// El índice no lleva cuerpos: ni de las pestañas, ni de las decisiones, ni
    /// el `doc.body` de antes de las pestañas que repetía el overview.
    #[test]
    fn the_outline_carries_no_bodies() {
        let out = doc_outline(&doc());
        let texto = out.to_string();
        for grande in ["EL OVERVIEW OTRA VEZ", "PORQUE LARGO", "SMTP por Brevo"] {
            assert!(!texto.contains(grande), "el índice lleva «{grande}»");
        }
        assert_eq!(
            out["tabs"][1]["key"], "runbook",
            "cada pestaña dice su nombre"
        );
        assert_eq!(out["tabs"][1]["sections"][1]["heading"], "Correo");
        assert!(out["tabs"][1]["sections"][1]["sectionHash"].is_string());
        assert_eq!(out["attachments"], 2);
    }

    /// Una escritura contesta con lo necesario para seguir, no con el doc.
    #[test]
    fn a_write_answers_short() {
        let out = short_tab_write(&doc(), "runbook");
        assert_eq!(out["bodyHash"], "h-r");
        assert!(!out.to_string().contains("SMTP"), "{out}");
    }

    /// Un conflicto trae la pestaña en conflicto, y sólo ésa.
    #[test]
    fn a_conflict_carries_only_its_own_tab() {
        let res = json!({ "conflict": true, "reason": "r", "doc": doc() });
        let out = short_conflict(&res, "overview").unwrap();
        assert_eq!(out["bodyHash"], "h-o");
        assert!(out["body"].as_str().unwrap().contains("Hola"));
        assert!(
            !out.to_string().contains("SMTP"),
            "trajo otra pestaña: {out}"
        );
        assert!(short_conflict(&json!({ "tab": "x" }), "overview").is_none());
    }

    /// El corazón de write_doc_section: con el hash que se leyó, escribe; si la
    /// sección cambió desde entonces, no escribe y devuelve su texto actual. El
    /// mutante que mata: escribir sin comparar.
    #[test]
    fn a_section_that_changed_is_not_overwritten() {
        let leido = section_hash(RUNBOOK, &find_section(RUNBOOK, "Correo").unwrap());

        let (_, nuevo) = plan_section_write(RUNBOOK, "runbook", "Correo", &leido, "Por SES.")
            .unwrap()
            .unwrap();
        assert!(nuevo.contains("Por SES.") && !nuevo.contains("Brevo"));

        // Alguien cambió la sección entre la lectura y la escritura.
        let ahora = RUNBOOK.replace("SMTP por Brevo.", "SMTP por Postmark.");
        let conflicto = plan_section_write(&ahora, "runbook", "Correo", &leido, "Por SES.")
            .unwrap()
            .unwrap_err();
        assert_eq!(conflicto["conflict"], true);
        assert!(
            conflicto["text"].as_str().unwrap().contains("Postmark"),
            "tiene que traer lo que hay ahora"
        );

        // Y si lo que cambió es OTRA sección, la suya sigue valiendo.
        let otra = RUNBOOK.replace("Con Actions.", "Con Actions y más.");
        assert!(
            plan_section_write(&otra, "runbook", "Correo", &leido, "Por SES.")
                .unwrap()
                .is_ok()
        );
    }

    /// La decisión apuntada es la de `createdAt` más reciente, no la primera de
    /// la lista: ésa va por `decidedAt`, y una decisión antigua apuntada hoy
    /// quedaría abajo.
    #[test]
    fn the_recorded_decision_is_the_newest_written() {
        assert_eq!(recorded_decision(&doc())["id"], "nueva");
    }

    // ── El catálogo ─────────────────────────────────────────────────────────

    fn tool<'a>(defs: &'a Value, name: &str) -> &'a Value {
        defs.as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap_or_else(|| panic!("no hay herramienta {name}"))
    }

    /// Lo que se anuncia es lo que se puede mandar. Si la herramienta no lo
    /// anuncia, un agente nunca lo manda; si lo anuncia y no lo reenvía, es la
    /// cicatriz. Esto cubre la primera mitad.
    // ── Adjuntar desde el MCP (7-oct-2026) ──────────────────────────────────

    /// `url` o `path`, uno y sólo uno, y la ruta absoluta. Mutantes: aceptar
    /// los dos; aceptar ninguno; aceptar una ruta relativa.
    #[test]
    fn an_attachment_comes_from_a_url_or_a_path() {
        assert_eq!(
            attachment_source(&json!({ "url": "https://x/a.png" })),
            Ok(AttachmentSource::Url("https://x/a.png".into()))
        );
        assert_eq!(
            attachment_source(&json!({ "path": "/tmp/a.png" })),
            Ok(AttachmentSource::Path("/tmp/a.png".into()))
        );
        assert!(attachment_source(&json!({ "url": "https://x/a.png", "path": "/tmp/a.png" })).is_err());
        assert!(attachment_source(&json!({})).is_err());
        assert!(attachment_source(&json!({ "path": "capturas/a.png" })).is_err());
    }

    /// Una imagen se enseña; lo demás se enlaza. Las notas devolvían siempre
    /// `![…]`, y un PDF salía como imagen rota. Mutante: siempre imagen.
    #[test]
    fn an_image_is_shown_and_anything_else_is_linked() {
        assert_eq!(attachment_markdown("a.png", "image/png", "/r"), "![a.png](/r)");
        assert_eq!(attachment_markdown("a.png", "IMAGE/PNG", "/r"), "![a.png](/r)");
        assert_eq!(attachment_markdown("b.pdf", "application/pdf", "/r"), "[b.pdf](/r)");
    }

    /// Una ruta pasa por las guardas de soltar un fichero: lo que no se
    /// adjunta (una llave, un .env) se rechaza antes de subir nada, con un
    /// mensaje que dice por qué; lo que sí, sale con su nombre y su tipo.
    /// Mutantes: leer la ruta sin las guardas; perder el tipo.
    #[test]
    fn a_local_path_only_reads_what_gets_attached() {
        let dir = std::env::temp_dir().join(format!("cac-mcp-att-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let env = dir.join(".env");
        std::fs::write(&env, b"SECRET=1").unwrap();
        let err = load_source(&AttachmentSource::Path(env)).unwrap_err();
        assert!(err.contains("can't be attached"), "{err}");

        let pdf = dir.join("informe.pdf");
        std::fs::write(&pdf, b"%PDF-1.7").unwrap();
        let (bytes, ctype, name) = load_source(&AttachmentSource::Path(pdf)).unwrap();
        assert_eq!((bytes.as_slice(), ctype.as_str(), name.as_str()), (&b"%PDF-1.7"[..], "application/pdf", "informe.pdf"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// El árbol de páginas sale anidado y con el enlace de cada página.
    /// Mutante: no anidar (todas en la raíz), o perder el enlace.
    #[test]
    fn the_page_tree_nests_children_and_carries_links() {
        let flat = json!([
            { "id": "a", "title": "Apps", "hasBody": false },
            { "id": "b", "parentId": "a", "title": "Nereus", "hasBody": true },
            { "id": "c", "parentId": null, "title": "Flujos", "hasBody": false }
        ]);
        let tree = build_page_tree(&flat, "list", "L1");
        assert_eq!(tree.as_array().unwrap().len(), 2, "dos páginas en la raíz");
        assert_eq!(tree[0]["children"][0]["title"], "Nereus");
        assert_eq!(tree[0]["children"][0]["link"], "/tasks?doc=list:L1&page=b");
    }

    /// El índice de una página no lleva el cuerpo, y sí sus títulos con hash.
    #[test]
    fn a_page_outline_carries_headings_not_the_body() {
        let view = json!({
            "page": { "id": "p", "title": "Nereus", "bodyHash": "h",
                      "body": "# Nereus\n\nTEXTO LARGO\n\n## Vistas\n\nmás" },
            "breadcrumb": [{ "id": "a", "title": "Apps" }],
            "children": [],
            "referencedFrom": [{ "kind": "task", "title": "Migrar", "link": "/tasks?task=t" }]
        });
        let out = page_outline(&view, "list", "L1");
        // Lo que enlaza aquí viaja con el índice: es lo que hay que revisar
        // antes de mover el contenido a otro sitio.
        assert_eq!(out["referencedFrom"][0]["link"], "/tasks?task=t");
        assert!(!out.to_string().contains("TEXTO LARGO"), "el índice lleva el cuerpo");
        assert_eq!(out["sections"][1]["heading"], "Vistas");
        assert!(out["sections"][1]["sectionHash"].is_string());
        assert_eq!(out["link"], "/tasks?doc=list:L1&page=p");
    }

    /// Un conflicto de página devuelve el cuerpo actual para fundir.
    #[test]
    fn a_page_conflict_returns_the_current_body() {
        let out = short_page_conflict(&json!({
            "conflict": true, "reason": "x",
            "doc": { "id": "p", "bodyHash": "nuevo", "body": "lo de otro" }
        }))
        .expect("un conflicto");
        assert_eq!(out["bodyHash"], "nuevo");
        assert_eq!(out["body"], "lo de otro");
        assert!(short_page_conflict(&json!({ "id": "p" })).is_none());
    }

    /// Las herramientas de páginas piden lo que necesitan para no pisar nada.
    #[test]
    fn the_page_tools_require_what_keeps_them_safe() {
        let defs = tool_defs();
        let req = |n: &str| tool(&defs, n)["inputSchema"]["required"].to_string();
        assert!(req("create_doc_page").contains("title"));
        assert!(req("write_doc_page_section").contains("sectionHash"));
        assert!(req("move_doc_page").contains("pageId"));
        assert!(req("delete_doc_page").contains("pageId"));
        assert!(tool(&defs, "write_doc_page")["inputSchema"]["properties"].get("baseHash").is_some());
    }

    /// El índice de un doc avisa de que hay páginas.
    #[test]
    fn the_pages_summary_counts_and_names_them() {
        let s = pages_summary(&json!([{ "title": "Uno" }, { "title": "Dos" }]));
        assert_eq!(s["count"], 2);
        assert_eq!(s["titles"][1], "Dos");
    }

    /// La herramienta existe, y las dos aceptan `path`. Mutante: no anunciarla.
    #[test]
    fn tasks_and_notes_take_a_file_from_disk() {
        let defs = tool_defs();
        for name in ["add_task_attachment", "add_note_attachment"] {
            let props = &tool(&defs, name)["inputSchema"]["properties"];
            assert!(props.get("path").is_some() && props.get("url").is_some(), "{name}");
        }
    }

    #[test]
    fn creating_and_editing_offer_tags_assignees_and_due_date() {
        let defs = tool_defs();
        for name in ["create_task", "update_task"] {
            let props = &tool(&defs, name)["inputSchema"]["properties"];
            for key in ["tags", "assignees", "dueAt"] {
                assert!(props.get(key).is_some(), "{name} no anuncia {key}");
            }
        }
        assert!(tool(&defs, "record_decision")["inputSchema"]["properties"]
            .get("originTaskId")
            .is_some());
        assert!(tool(&defs, "search")["inputSchema"]["properties"]
            .get("query")
            .is_some());
        let get_doc = &tool(&defs, "get_doc")["inputSchema"]["properties"];
        assert!(get_doc.get("tab").is_some() && get_doc.get("section").is_some());
        assert!(
            tool(&defs, "request_doc_review")["inputSchema"]["properties"]
                .get("note")
                .is_some()
        );
        assert!(
            tool(&defs, "update_task")["inputSchema"]["properties"]
                .get("clearDueAt")
                .is_some(),
            "sin esto un agente no tiene forma de quitar un vencimiento"
        );
        let required = tool(&defs, "write_doc_section")["inputSchema"]["required"].to_string();
        assert!(
            required.contains("sectionHash"),
            "reescribir una sección sin su hash pisaría lo que no se leyó"
        );
    }

    // ── Los .md del repo (docs as code) ─────────────────────────────────────

    /// Un .md del repo se lee como una página: índice, sección o entero, y
    /// siempre dice que es de sólo lectura. Uno demasiado grande no trae
    /// cuerpo. Mutantes: devolver el cuerpo sin pedirlo; sin `readOnly`; la
    /// sección equivocada.
    #[test]
    fn a_repo_doc_reads_like_a_page() {
        let d = json!({
            "id": "rd-1", "title": "Desplegar", "path": "docs/deploy.md", "fullName": "dwit/web",
            "branch": "main", "htmlUrl": "https://github.com/dwit/web/blob/main/docs/deploy.md",
            "tooLarge": false,
            "body": "# Desplegar\n\nIntro.\n\n## Pasos\n\nmake deploy\n\n## Volver atrás\n\nmake rollback\n"
        });
        let outline = repo_doc_view(&d, None, false).unwrap();
        assert_eq!(outline["readOnly"], true);
        assert!(outline.get("lastCommit").is_none(), "sin commit contado no se inventa");
        let mut stamped = d.clone();
        stamped["lastCommitSha"] = json!("abc");
        stamped["lastAuthor"] = json!("ana");
        assert_eq!(repo_doc_view(&stamped, None, false).unwrap()["lastCommit"]["author"], "ana");
        assert!(outline.get("body").is_none());
        let heads: Vec<&str> = outline["headings"].as_array().unwrap().iter()
            .map(|h| h["heading"].as_str().unwrap()).collect();
        assert_eq!(heads, ["Desplegar", "Pasos", "Volver atrás"]);

        let sec = repo_doc_view(&d, Some("Pasos"), false).unwrap();
        let text = sec["text"].as_str().unwrap();
        assert!(text.contains("make deploy") && !text.contains("rollback"), "{text}");

        assert!(repo_doc_view(&d, None, true).unwrap()["body"].as_str().unwrap().contains("rollback"));

        let big = json!({ "id": "rd-2", "tooLarge": true, "body": "" });
        let out = repo_doc_view(&big, None, true).unwrap();
        assert_eq!(out["tooLarge"], true);
        assert!(out.get("body").is_none());
    }

    // ── Configurar el despliegue (16-oct-2026) ──────────────────────────────

    /// Editar un servicio rellena lo obligatorio con lo que ya tiene, sólo
    /// toca lo pedido y nunca el comando de migraciones. Mutantes: mandar
    /// vacío lo no pedido (borraría el repo); dejar pasar `migrateCommand`;
    /// mandar los opcionales aunque no se pidan.
    #[test]
    fn editing_a_deployable_keeps_what_was_not_asked() {
        let current = json!({
            "id": "d1", "name": "web", "environment": "prod", "repoFullName": "dwit/web",
            "onCINotify": "deploy", "branch": "main", "migrateCommand": "make migrate"
        });
        let (body, changed) = deploy_update_body(&current, &json!({ "branch": "dev", "buildOnHost": true })).unwrap();
        assert_eq!(body["name"], "web");
        assert_eq!(body["repoFullName"], "dwit/web");
        assert_eq!(body["onCINotify"], "deploy");
        assert_eq!(body["branch"], "dev");
        assert_eq!(body["buildOnHost"], true);
        assert!(body.get("dockerfile").is_none(), "lo no pedido no viaja");
        assert!(body.get("migrateCommand").is_none());
        assert_eq!(changed, vec!["branch", "buildOnHost"]);
        // Junto con algo válido, para que el error sea por el comando y no por
        // «nada que cambiar».
        let err = deploy_update_body(&current, &json!({ "branch": "dev", "migrateCommand": "rm -rf /" })).unwrap_err();
        assert!(err.contains("migration"), "{err}");
        assert!(deploy_update_body(&current, &json!({})).is_err());
    }

    /// Los secrets por nombre: por defecto se combinan; `remove` quita y
    /// `replace` deja sólo lo pedido. Mutantes: reemplazar siempre (perdería
    /// los demás); duplicar uno que ya estaba; no validar `usage`.
    #[test]
    fn secret_refs_merge_by_name() {
        let current = vec![
            json!({ "name": "DATABASE_URL", "opRef": "op://v/db/url", "usage": "both" }),
            json!({ "name": "GTM_ID", "opRef": "op://v/gtm/id", "usage": "" }),
        ];
        let out = merge_secret_refs(
            &current,
            &[json!({ "name": "GTM_ID", "opRef": "op://v/gtm/id2", "usage": "build" }),
              json!({ "name": "SENTRY_DSN", "opRef": "op://v/sentry/dsn" })],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(out.len(), 3, "uno cambia, uno se añade y el otro se queda");
        assert_eq!(out[0]["usage"], "both");
        assert_eq!(out[1]["opRef"], "op://v/gtm/id2");
        assert_eq!(out[2]["usage"], "runtime", "sin usage, runtime");
        let out = merge_secret_refs(&current, &[], &["GTM_ID".to_string()], false).unwrap();
        assert_eq!(out.len(), 1);
        let out = merge_secret_refs(&current, &[json!({ "name": "A", "opRef": "op://v/a/b" })], &[], true).unwrap();
        assert_eq!(out.len(), 1);
        assert!(merge_secret_refs(&current, &[json!({ "name": "A", "opRef": "op://x", "usage": "siempre" })], &[], false).is_err());
        assert!(merge_secret_refs(&current, &[json!({ "name": "A" })], &[], false).is_err());
    }

    /// Las herramientas existen, piden el permiso propio y `update_deploy_config`
    /// no ofrece el comando de migraciones. Mutante: anunciarlo.
    #[test]
    fn the_deploy_tools_are_there_and_never_touch_migrations() {
        let defs = tool_defs();
        for name in ["list_servers", "list_deployables", "get_deploy_config", "create_deployable", "update_deploy_config", "set_secret_refs"] {
            assert!(!tool(&defs, name).is_null(), "falta {name}");
        }
        for name in ["create_deployable", "update_deploy_config", "set_secret_refs"] {
            assert!(tool(&defs, name)["description"].as_str().unwrap().contains("deploys:manage"), "{name}");
        }
        assert!(tool(&defs, "update_deploy_config")["inputSchema"]["properties"].get("migrateCommand").is_none());
    }

    /// Los backups en el MCP son de sólo lectura: ninguna herramienta lanza
    /// uno ni descarga. Mutante: añadir un `run_backup` o un `download`.
    #[test]
    fn backup_tools_only_read() {
        let defs = tool_defs();
        for name in ["list_backups", "get_backup_history"] {
            assert!(!tool(&defs, name).is_null(), "falta {name}");
        }
        let names: Vec<String> = defs.as_array().unwrap().iter()
            .filter_map(|t| t["name"].as_str().map(str::to_string))
            .filter(|n| n.contains("backup"))
            .collect();
        assert_eq!(names, ["list_backups", "get_backup_history"]);
    }

    /// El muro: el agente publica, comenta y reacciona, y un comunicado se
    /// redacta como borrador; no hay herramienta para publicar un borrador,
    /// editar, borrar ni fijar — eso lo hace una persona. Mutantes: añadir una
    /// de esas herramientas; describir el comunicado como publicado.
    /// Roturas que detecta: no reconocer una de las formas del remote (ssh,
    /// https, con `.git`, con usuario delante), o tomar por GitHub lo que no lo es.
    #[test]
    fn a_github_remote_in_any_form_is_owner_and_name() {
        for url in [
            "git@github.com:guz-studio/cac.git",
            "https://github.com/guz-studio/cac",
            "https://github.com/guz-studio/cac.git",
            "https://github.com/guz-studio/cac/",
            "ssh://git@github.com/guz-studio/cac.git",
            "https://x-access-token:abc@github.com/guz-studio/cac.git",
        ] {
            assert_eq!(github_repo_from_remote(url).as_deref(), Some("guz-studio/cac"), "{url}");
        }
        assert_eq!(github_repo_from_remote("git@gitlab.com:guz/cac.git"), None);
        assert_eq!(github_repo_from_remote("https://github.com/guz-studio"), None);
        assert_eq!(github_repo_from_remote("https://github.com/a/b/tree/main"), None);
    }

    /// Rotura que detecta: no leer el remote de la carpeta (el agente tendría
    /// que preguntar en qué espacio está). Usa este mismo repo.
    #[test]
    fn the_remote_of_this_checkout_is_read() {
        let here = env!("CARGO_MANIFEST_DIR");
        let url = git_remote(here).expect("este checkout tiene remote");
        assert!(github_repo_from_remote(&url).is_some(), "{url}");
        assert!(git_remote("/").is_err());
    }

    /// Rotura que detecta: tomar el primer remote en vez de `origin` (con un
    /// fork, `aaa` saldría antes por orden alfabético).
    #[test]
    fn origin_wins_over_other_remotes() {
        let d = std::env::temp_dir().join(format!("cac-remote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git").arg("-C").arg(&d).args(args).output().unwrap().status.success());
        };
        git(&["init", "-q"]);
        git(&["remote", "add", "aaa", "git@gitlab.com:otro/fork.git"]);
        git(&["remote", "add", "origin", "git@github.com:guz-studio/cac.git"]);
        assert_eq!(git_remote(d.to_str().unwrap()).unwrap(), "git@github.com:guz-studio/cac.git");
        let _ = std::fs::remove_dir_all(d);
    }

    /// Roturas que detecta: aceptar un estado que el backend no conoce (el
    /// error llegaría como un 400 opaco), aceptar status y statusId a la vez,
    /// o perder el statusId de siempre.
    #[test]
    fn a_task_moves_by_state_name_or_by_column_id() {
        for st in ["open", "in_progress", "done", "closed"] {
            assert_eq!(move_target(&json!({ "status": st })).unwrap().as_deref(), Some(st));
        }
        assert!(move_target(&json!({ "status": "resolved_ish" })).is_err());
        assert!(move_target(&json!({ "status": "done", "statusId": "L/resolved" })).is_err());
        assert_eq!(move_target(&json!({ "statusId": "L/resolved" })).unwrap().as_deref(), Some("L/resolved"));
        assert_eq!(move_target(&json!({})).unwrap(), None);
        // Lo que anuncia la herramienta es lo que acepta.
        let defs = tool_defs();
        let ut = defs.as_array().unwrap().iter().find(|t| t["name"] == "update_task").unwrap();
        assert_eq!(ut["inputSchema"]["properties"]["status"]["enum"], json!(["open", "in_progress", "done", "closed"]));
    }

    /// Roturas que detecta: crear líneas vacías, pasar de 30, o que la clave
    /// de una subtarea no dependa de su posición (al reintentar, la segunda
    /// línea devolvería la primera).
    #[test]
    fn a_checklist_is_created_with_its_task() {
        assert_eq!(subtask_titles(&json!({})).unwrap(), None);
        assert_eq!(subtask_titles(&json!({ "subtasks": [] })).unwrap(), None);
        assert_eq!(
            subtask_titles(&json!({ "subtasks": [" Backend ", "App"] })).unwrap(),
            Some(vec!["Backend".to_string(), "App".to_string()])
        );
        assert!(subtask_titles(&json!({ "subtasks": ["ok", "  "] })).is_err());
        assert!(subtask_titles(&json!({ "subtasks": "una" })).is_err());
        assert!(subtask_titles(&json!({ "subtasks": vec!["x"; 31] })).is_err());
        assert_ne!(subtask_key("k", 0), subtask_key("k", 1));
        assert_ne!(subtask_key("k", 0), "k");
        let defs = tool_defs();
        let ct = defs.as_array().unwrap().iter().find(|t| t["name"] == "create_task").unwrap();
        assert_eq!(ct["inputSchema"]["properties"]["subtasks"]["type"], json!("array"));
    }

    /// Un cac falso: contesta a cada petición con `answer(método, ruta, cuerpo)`
    /// dentro del sobre `{success, data}` y apunta lo que le pidieron. Cierra
    /// cada conexión, así que cada petición llega por separado.
    fn fake_cac(
        answer: impl Fn(&str, &str, &Value) -> Value + Send + 'static,
    ) -> (Cfg, std::sync::Arc<std::sync::Mutex<Vec<(String, String, Value)>>>) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut parts = line.split_whitespace();
                let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                let mut len = 0;
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut buf = vec![0; len];
                reader.read_exact(&mut buf).unwrap();
                let body: Value = serde_json::from_slice(&buf).unwrap_or(Value::Null);
                let data = answer(&method, &path, &body);
                log.lock().unwrap().push((method, path, body));
                let out = json!({ "success": true, "data": data }).to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                    out.len()
                );
            }
        });
        (Cfg { base, token: "cac_pat_test".into() }, seen)
    }

    /// De punta a punta contra un cac falso. Rotura que detecta: que
    /// `update_task` no lea `status` (se quedaba en el `statusId` de siempre y
    /// el agente volvía a pedir el tablero).
    #[test]
    fn update_task_moves_by_state_name() {
        let (cfg, seen) = fake_cac(|_, _, _| json!({ "task": { "id": "t1" }, "status": { "name": "Done", "kind": "done" } }));
        let out = call_tool(&cfg, "update_task", &json!({ "id": "t1", "status": "done" })).unwrap();
        assert_eq!(out["task"]["column"], "Done");
        let seen = seen.lock().unwrap();
        let mv = seen.iter().find(|(m, p, _)| m == "POST" && p == "/api/v1/tasks/t1/move").expect("no movió la tarea");
        assert_eq!(mv.2["statusId"], "done");
    }

    /// De punta a punta contra un cac falso. Roturas que detecta: no crear las
    /// líneas, colgarlas sueltas (sin `parentId`) o con la misma clave.
    #[test]
    fn create_task_creates_its_checklist_in_the_same_call() {
        let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = n.clone();
        let (cfg, seen) = fake_cac(move |_, _, body| {
            let i = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            json!({ "id": format!("t{i}"), "seq": 10 + i, "title": body["title"], "parentId": body.get("parentId") })
        });
        let out = call_tool(
            &cfg,
            "create_task",
            &json!({ "listId": "L", "title": "Padre", "idempotencyKey": "k", "subtasks": ["Backend", "App"] }),
        )
        .unwrap();
        assert_eq!(out["id"], "t0");
        assert_eq!(out["subtasks"].as_array().unwrap().len(), 2);
        let seen = seen.lock().unwrap();
        let posts: Vec<&Value> = seen.iter().filter(|(m, p, _)| m == "POST" && p == "/api/v1/task-lists/L/tasks").map(|x| &x.2).collect();
        assert_eq!(posts.len(), 3, "{seen:?}");
        assert_eq!(posts[1]["parentId"], "t0");
        assert_eq!(posts[2]["parentId"], "t0");
        assert_eq!(posts[2]["title"], "App");
        assert_ne!(posts[1]["idempotencyKey"], posts[2]["idempotencyKey"]);
        assert_ne!(posts[1]["idempotencyKey"], posts[0]["idempotencyKey"]);
    }

    /// Una carpeta de skills desechable por prueba.
    fn skills_tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cac-skill-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn write_installed(dir: &std::path::Path, text: &str) {
        std::fs::create_dir_all(dir.join(WORK_SKILL_NAME)).unwrap();
        std::fs::write(dir.join(WORK_SKILL_NAME).join("SKILL.md"), text).unwrap();
    }

    /// Roturas que detecta: quitar la marca de versión de la skill (nunca se
    /// ofrecería actualizar), o leerla mal.
    #[test]
    fn the_shipped_skill_carries_its_version() {
        assert!(skill_version(WORK_SKILL).is_some(), "la skill necesita su <!-- cac-work vN -->");
        assert_eq!(skill_version("x\n<!-- cac-work v7 -->\n"), Some(7));
        assert_eq!(skill_version("sin marca"), None);
        assert!(WORK_SKILL.starts_with("---\nname: cac-work\n"), "el nombre de la skill es el de su carpeta");
    }

    /// Roturas que detecta: dar por buena una copia vieja o sin marca, u
    /// ofrecer "actualizar" una más nueva.
    #[test]
    fn the_installed_skill_is_missing_outdated_or_current() {
        let ship = skill_version(WORK_SKILL).unwrap();
        let d = skills_tmp("state");
        assert_eq!(skill_state(&d), SkillState::Missing);
        write_installed(&d, "una copia a mano");
        assert_eq!(skill_state(&d), SkillState::Outdated);
        write_installed(&d, &format!("<!-- cac-work v{} -->", ship.saturating_sub(1)));
        assert_eq!(skill_state(&d), if ship == 0 { SkillState::Current } else { SkillState::Outdated });
        write_installed(&d, WORK_SKILL);
        assert_eq!(skill_state(&d), SkillState::Current);
        write_installed(&d, &format!("<!-- cac-work v{} -->", ship + 1));
        assert_eq!(skill_state(&d), SkillState::Current);
        let _ = std::fs::remove_dir_all(d);
    }

    /// Roturas que detecta: no recordar siempre lo de la tarea (era el
    /// recordatorio que hacía jose a mano), sugerir instalar lo ya instalado,
    /// o no sugerirlo cuando falta.
    #[test]
    fn the_instructions_always_remind_and_only_suggest_when_needed() {
        for st in [None, Some(SkillState::Missing), Some(SkillState::Outdated), Some(SkillState::Current)] {
            let text = instructions(st);
            assert!(text.contains("update the task"), "{text}");
            assert!(text.contains("call get_context"), "{text}");
        }
        assert!(instructions(Some(SkillState::Missing)).contains("call install_skill"));
        assert!(instructions(Some(SkillState::Missing)).contains("Do not install it without asking"));
        assert!(instructions(Some(SkillState::Outdated)).contains("call install_skill"));
        assert!(!instructions(Some(SkillState::Current)).contains("install_skill"));
        assert!(!instructions(None).contains("install_skill"));
    }

    /// Roturas que detecta: no escribirla, escribir otra cosa, pisar una copia
    /// más nueva, o escribir en un dryRun.
    #[test]
    fn install_skill_writes_the_shipped_text_and_never_downgrades() {
        let d = skills_tmp("install");
        let dry = install_skill(&d, true).unwrap();
        assert_eq!(dry["dryRun"], json!(true));
        assert!(!d.exists(), "un dryRun no escribe");

        let out = install_skill(&d, false).unwrap();
        assert_eq!(out["replaced"], json!(false));
        let path = d.join(WORK_SKILL_NAME).join("SKILL.md");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), WORK_SKILL);

        write_installed(&d, "vieja");
        assert_eq!(install_skill(&d, false).unwrap()["replaced"], json!(true));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), WORK_SKILL);

        let newer = format!("<!-- cac-work v{} -->", skill_version(WORK_SKILL).unwrap() + 1);
        write_installed(&d, &newer);
        assert!(install_skill(&d, false).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
        let _ = std::fs::remove_dir_all(d);
    }

    /// Rotura que detecta: que instalar la skill pida token (está para quien
    /// aún no ha configurado nada) o que no se anuncie.
    #[test]
    fn install_skill_is_local_and_listed() {
        assert!(LOCAL_TOOLS.contains(&"install_skill"));
        let defs = tool_defs();
        let def = defs.as_array().unwrap().iter().find(|t| t["name"] == "install_skill").expect("anunciada");
        assert!(def["description"].as_str().unwrap().contains("ASK THE USER FIRST"));
        let init = handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }), &Err("sin token".into())).unwrap();
        assert!(init["result"]["instructions"].as_str().unwrap().contains("update the task"));
    }

    #[test]
    fn the_wall_tools_only_add() {
        let defs = tool_defs();
        let names: Vec<String> = defs.as_array().unwrap().iter()
            .filter_map(|t| t["name"].as_str().map(str::to_string))
            .filter(|n| n.contains("post") && !n.contains("report"))
            .collect();
        assert_eq!(names, ["list_posts", "get_post", "create_post", "comment_post", "react_post"]);
        let create = tool(&defs, "create_post")["description"].as_str().unwrap().to_string();
        assert!(create.contains("DRAFT") && create.contains("posts:write"), "{create}");
    }

    /// `notify_me` existe, pide su permiso y **no** ofrece a quién: el
    /// destinatario es siempre la persona del token. Mutante: anunciar un
    /// `userId` (o cualquier otro destinatario).
    #[test]
    fn notify_me_has_no_recipient() {
        let defs = tool_defs();
        let t = tool(&defs, "notify_me");
        assert!(t["description"].as_str().unwrap().contains("notify:me"));
        let props = t["inputSchema"]["properties"].as_object().unwrap();
        let mut keys: Vec<&str> = props.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["body", "dryRun", "link", "orgId", "title"]);
    }
}

