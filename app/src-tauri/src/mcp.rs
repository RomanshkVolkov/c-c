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
            "description": "Find tasks, notes and docs by text, instead of pulling whole boards. Returns what matched and where (kind, id, title, where, link), and a `snippet` with the matching words between ** where it is safe to show: a doc, a task's description (never a comment: it may be internal), a note. Each doc hit also carries its `ownerKind`/`ownerId`, and either the `tab` of the node's home or the `pageId` of a subpage, with `where` as the page's path. Open a hit with get_task, get_note, get_doc (tab) or get_doc_page (pageId).\n\nEverything is full-text: words match by prefix and without accents, and titles rank first. Tasks match by title, description and comments; notes by title and body; docs by the home tabs and every page. Channel messages and direct messages are not searchable from here.",
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
            "description": "Create a task in a list. Use list_task_spaces first to resolve the list name to its listId. Needs a token with the `tasks:write` scope.\n\nIf the list belongs to a client's channel (list_task_spaces shows a projectId on it), anything created there is VISIBLE TO THAT CLIENT by default: it lands on their board, takes a number from their folio sequence — permanently, even if withdrawn later — and fires their webhook. Pass visibility:\"internal\" to keep it to the team.\n\nA checklist inside a task is its SUBTASKS: create each line with parentId, and tick it off with update_task + statusId. Don't keep pending items as text in comments — nobody can tell which ones are done.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "listId": { "type": "string", "description": "Target list (from list_task_spaces)." },
                    "title": { "type": "string" },
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
            "description": "Change an existing task: title, markdown description, priority, tags, assignees, due date, or which column it sits in (statusId, from get_board). Needs a token with the `tasks:manage` scope — separate from creating, because this overwrites work someone else may have written. Only the fields you send are touched.",
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
                    "statusId": { "type": "string", "description": "Move the task to this column. get_board returns a statusId per column. This is also how a subtask is ticked off: move it to a done column of its parent's list." },
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
            // Echo back what was created, including the sequence number, so the
            // caller can refer to the task without another round trip.
            Ok(json!({
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
            let status_id = arg_str(args, "statusId");
            if body.as_object().map(|o| o.is_empty()).unwrap_or(true) && status_id.is_none() {
                return Err(
                    "Nothing to change: send at least one of title, description, priority, visibility, tags, assignees, dueAt or statusId"
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
                "serverInfo": { "name": "cac", "version": env!("CARGO_PKG_VERSION") }
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
const LOCAL_TOOLS: &[&str] = &["compress_image"];

fn call_local_tool(name: &str, args: &Value) -> Result<Value, String> {
    match name {
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
}

