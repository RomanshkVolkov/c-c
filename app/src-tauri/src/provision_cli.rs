//! `cac provision`: pedir y aplicar un playbook desde una terminal con la config
//! de cac, siguiendo el protocolo (decisión 4d28f4ab, diseño «Ejecución por
//! agentes con riesgo evaluado y protocolo»).
//!
//! Es la misma receta que el botón de la pestaña Provisioning
//! (`ansible::plan_run` + `ansible::run_playbook`), para `make` y para un agente
//! que trabaja en la terminal de una persona. Corre en esta máquina: las llaves
//! SSH las da el agente de 1Password y los secretos se leen con `op read`, que
//! piden aprobación. A cac sólo le llega el registro (con el token de
//! `CAC_TOKEN`, que necesita `servers:manage`), nunca un valor.
//!
//! ```text
//! cac provision plan    --server gstd --playbook swarm [--folder infra/ansible]
//! cac provision request --server gstd --playbook swarm [--reason "…"] [--folder …]
//! cac provision run     --server gstd --grant <petición> [--folder …]
//! ```
//!
//! `request` abre la petición y corre el **ensayo** (`--check --diff`, no
//! cambia nada); cac lo evalúa. Sólo una lectura limpia queda autorizada en el
//! acto; lo demás lo aprueba una persona en la app. `run` sólo corre con una
//! autorización vigente, y después corre su `verify`.

use crate::ansible::{self, AnsibleEvent, Manifest, PlaybookDef, RunSpec};
use crate::mcp::{api_get, api_patch, api_post, api_put, cfg, urlencode, Cfg};
use serde_json::{json, Value};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

/// Lo que se pide por la línea de comandos.
#[derive(Debug, PartialEq, Default)]
pub struct CliArgs {
    pub action: String,
    pub server: String,
    pub playbook: String,
    pub folder: String,
    pub grant: String,
    pub reason: String,
}

const USAGE: &str = "usage:
  cac provision plan    --server <name or id> --playbook <id> [--folder <ansible project>]
  cac provision request --server <name or id> --playbook <id> [--reason <why>] [--folder …]
  cac provision run     --server <name or id> --grant <request id> [--folder …]";

pub fn parse_args(args: &[String]) -> Result<CliArgs, String> {
    let mut it = args.iter().skip_while(|a| a.as_str() != "provision").skip(1);
    let action = it.next().cloned().ok_or(USAGE)?;
    if !["run", "plan", "request"].contains(&action.as_str()) {
        return Err(USAGE.into());
    }
    let mut a = CliArgs { action, folder: ".".into(), ..Default::default() };
    while let Some(flag) = it.next() {
        let val = it.next().cloned().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--server" => a.server = val,
            "--playbook" => a.playbook = val,
            "--folder" => a.folder = val,
            "--grant" => a.grant = val,
            "--reason" => a.reason = val,
            _ => return Err(format!("unknown option {flag}\n{USAGE}")),
        }
    }
    if a.server.is_empty() {
        return Err(USAGE.into());
    }
    match a.action.as_str() {
        // Correr es siempre con una autorización: el playbook sale de ella,
        // no de lo que se escriba aquí.
        "run" if a.grant.is_empty() => Err(format!(
            "`run` needs --grant: ask first with `cac provision request` (only a clean read is authorized at once; the rest is approved by a person in the app)\n{USAGE}"
        )),
        "run" if !a.playbook.is_empty() => Err("`run` takes the playbook from its grant: drop --playbook".into()),
        "plan" | "request" if a.playbook.is_empty() => Err(USAGE.into()),
        _ => Ok(a),
    }
}

/// El servidor por id o por nombre exacto. Dos con el mismo nombre (en orgs
/// distintas) es un error que pide el id: aplicar a la máquina equivocada no
/// se deshace.
pub fn pick_server(servers: &Value, wanted: &str) -> Result<Value, String> {
    let all = servers.as_array().cloned().unwrap_or_default();
    if let Some(s) = all.iter().find(|s| s["id"].as_str() == Some(wanted)) {
        return Ok(s.clone());
    }
    let named: Vec<&Value> = all.iter().filter(|s| s["name"].as_str() == Some(wanted)).collect();
    match named.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(format!("no server called `{wanted}` (list_servers, or pass its id)")),
        _ => Err(format!("more than one server is called `{wanted}`: pass its id")),
    }
}

pub fn main(args: Vec<String>) -> i32 {
    match run(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("cac provision: {e}");
            2
        }
    }
}

/// Lo común: la carpeta del manifiesto, el servidor y su config efectiva.
struct Context {
    c: Cfg,
    folder: String,
    project: String,
    manifest: Manifest,
    server: Value,
    server_id: String,
}

fn context(server: &str, folder: &str) -> Result<Context, String> {
    let path = std::fs::canonicalize(folder).map_err(|e| format!("{folder}: {e}"))?;
    let folder = path.to_string_lossy().into_owned();
    let manifest = ansible::ansible_manifest(folder.clone())?;
    let c = cfg()?;
    let server = pick_server(&api_get(&c, "/api/v1/servers")?, server)?;
    let server_id = server["id"].as_str().unwrap_or_default().to_string();
    let project = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Context { c, folder, project, manifest, server, server_id })
}

impl Context {
    fn effective(&self, seq: i64) -> Result<Value, String> {
        let q = if seq > 0 { format!("?seq={seq}") } else { String::new() };
        api_get(&self.c, &format!("/api/v1/servers/{}/config/effective{q}", urlencode(&self.server_id)))
    }
    fn requests_path(&self) -> String {
        format!("/api/v1/servers/{}/provisioning-requests", urlencode(&self.server_id))
    }
    fn name(&self) -> &str {
        self.server["name"].as_str().unwrap_or(&self.server_id)
    }
}

fn playbook<'a>(m: &'a Manifest, id: &str) -> Result<&'a PlaybookDef, String> {
    m.playbooks
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("`{id}` is not a playbook of {}", ansible::MANIFEST_FILE))
}

fn run(args: Vec<String>) -> Result<i32, String> {
    let a = parse_args(&args)?;
    match a.action.as_str() {
        "plan" => plan(&a),
        "request" => {
            let out = request(&a.server, &a.playbook, &a.reason, &a.folder, true)?;
            print_request(&out);
            Ok(if out["status"] == "approved" || out["status"] == "awaiting_approval" { 0 } else { 1 })
        }
        _ => run_grant(&a),
    }
}

fn plan(a: &CliArgs) -> Result<i32, String> {
    let ctx = context(&a.server, &a.folder)?;
    let effective = ctx.effective(0)?;
    let (spec, gaps) = ansible::plan_run(&ctx.folder, &ctx.manifest, &a.playbook, &effective)?;
    let pb = playbook(&ctx.manifest, &a.playbook)?;
    println!(
        "cac provision: {} → {} (config v{}{}), risk {}",
        a.playbook,
        ctx.name(),
        effective["configSeq"].as_i64().unwrap_or(0),
        effective["templateName"].as_str().map(|t| format!(", plantilla «{t}»")).unwrap_or_default(),
        pb.risk.as_deref().unwrap_or("?"),
    );
    // Sólo nombres: lo mismo que se apunta en cac.
    println!("variables: {}", spec.var_names().join(", "));
    match gaps.check() {
        Ok(()) => {
            println!("listo para pedir");
            Ok(0)
        }
        Err(e) => {
            println!("{e}");
            Ok(1)
        }
    }
}

/// Pasos 0 a 2 del protocolo: abre la petición con la config actual, corre el
/// ensayo y se lo manda a cac, que lo evalúa. Devuelve la petición tal como
/// queda (`approved` sólo si era una lectura limpia; si no,
/// `awaiting_approval`).
///
/// **Siempre en ensayo** (`check: true`): esta función no tiene camino para
/// correr un playbook de verdad. Es la que usa la herramienta MCP
/// `request_provisioning`, y una prueba lo fija.
pub fn request(server: &str, playbook_id: &str, reason: &str, folder: &str, echo: bool) -> Result<Value, String> {
    let ctx = context(server, folder)?;
    let pb = playbook(&ctx.manifest, playbook_id)?;
    let risk = pb.risk.clone().ok_or_else(|| {
        format!("`{playbook_id}` declares no risk: {} needs version 2 with `risk`", ansible::MANIFEST_FILE)
    })?;
    let effective = ctx.effective(0)?;
    let config_seq = effective["configSeq"].as_i64().unwrap_or(0);
    if config_seq < 1 {
        return Err(format!("{} has no config in cac yet (set_server_config)", ctx.name()));
    }
    let (spec, gaps) = ansible::plan_run(&ctx.folder, &ctx.manifest, playbook_id, &effective)?;
    gaps.check()?;

    let req = api_post(
        &ctx.c,
        &ctx.requests_path(),
        json!({
            "playbook": playbook_id,
            "project": ctx.project,
            "risk": risk,
            "verify": pb.verify.clone().unwrap_or_default(),
            "rollback": pb.rollback.clone().unwrap_or_default(),
            "configSeq": config_seq,
            "reason": reason,
        }),
    )?;
    let id = req["id"].as_str().unwrap_or_default().to_string();
    if echo {
        println!("cac provision: petición {id} · {playbook_id} ({risk}) → {} (config v{config_seq}) · ensayo…", ctx.name());
    }
    let (code, lines) = dry_run(spec, echo)?;
    let report = check_report(&lines, code.unwrap_or(-1));
    api_put(&ctx.c, &format!("{}/{}/check", ctx.requests_path(), urlencode(&id)), report)
}

/// El ensayo: el mismo `RunSpec`, en `--check --diff`. No abre ninguna
/// ejecución en cac: lo que dice va en la petición.
fn dry_run(mut spec: RunSpec, echo: bool) -> Result<(Option<i32>, Vec<String>), String> {
    spec.check = true;
    let (code, cancelled, lines) = play(spec, echo)?;
    if cancelled {
        return Err("the dry run was cancelled".into());
    }
    Ok((code, lines))
}

/// Corre un spec y espera: código, si se canceló y la salida (ya tachada).
fn play(spec: RunSpec, echo: bool) -> Result<(Option<i32>, bool, Vec<String>), String> {
    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel::<(Option<i32>, bool)>();
    let sink_lines = lines.clone();
    let tx = Mutex::new(tx);
    let sink: ansible::Sink = Arc::new(move |e| match e {
        AnsibleEvent::Line { stream, text } => {
            // Sin eco en el MCP: su stdout es el protocolo.
            if echo {
                if stream == "stderr" {
                    eprintln!("{text}");
                } else {
                    println!("{text}");
                }
            }
            let mut l = sink_lines.lock().unwrap();
            l.push(text);
            let n = l.len();
            if n > 5000 {
                l.drain(..n - 5000);
            }
        }
        AnsibleEvent::Exit { code, cancelled } => {
            let _ = tx.lock().unwrap().send((code, cancelled));
        }
    });
    ansible::run_playbook(spec, sink)?;
    let (code, cancelled) = rx.recv().map_err(|e| e.to_string())?;
    let l = lines.lock().unwrap().clone();
    Ok((code, cancelled, l))
}

/// Pasos 4 y 5: corre con la autorización y, si sale bien, su verificación.
fn run_grant(a: &CliArgs) -> Result<i32, String> {
    let ctx = context(&a.server, &a.folder)?;
    let req = api_get(&ctx.c, &format!("{}/{}", ctx.requests_path(), urlencode(&a.grant)))?;
    if req["status"] != "approved" {
        return Err(format!(
            "request {} is `{}`, not approved{}",
            a.grant,
            req["status"].as_str().unwrap_or("?"),
            if req["status"] == "awaiting_approval" { ": a person approves it in the app (Provisioning)" } else { "" }
        ));
    }
    let playbook_id = req["playbook"].as_str().unwrap_or_default().to_string();
    let pb = playbook(&ctx.manifest, &playbook_id)?;
    // El riesgo aprobado es el del manifiesto de ahora. Si alguien lo cambió
    // desde que se pidió, lo aprobado ya no es esto: se pide otra vez.
    if pb.risk.as_deref() != req["risk"].as_str() {
        return Err(format!(
            "`{playbook_id}` is `{}` in {} but was approved as `{}`: ask again",
            pb.risk.as_deref().unwrap_or("?"),
            ansible::MANIFEST_FILE,
            req["risk"].as_str().unwrap_or("?")
        ));
    }
    let seq = req["configSeq"].as_i64().unwrap_or(0);
    let effective = ctx.effective(seq)?;
    println!(
        "cac provision: {playbook_id} → {} (config v{seq}) con la autorización {}",
        ctx.name(),
        a.grant
    );
    let status = execute(&ctx, &effective, &playbook_id, &a.grant, seq)?;

    let verify = req["verify"].as_str().unwrap_or_default().to_string();
    if status == "succeeded" && req["risk"] != "read" && !verify.is_empty() {
        println!("cac provision: verificando con {verify}…");
        execute(&ctx, &effective, &verify, &a.grant, seq)?;
    }
    let done = api_get(&ctx.c, &format!("{}/{}", ctx.requests_path(), urlencode(&a.grant)))?;
    let final_status = done["status"].as_str().unwrap_or("?").to_string();
    println!("cac provision: la petición queda `{final_status}`");
    if final_status != "succeeded" {
        let rollback = req["rollback"].as_str().unwrap_or_default();
        let hint = if rollback.is_empty() {
            String::new()
        } else {
            format!(" Rollback propuesto: `{rollback}` (es otra petición; no corre solo).")
        };
        println!("cac provision:{hint}");
        // Paso 5: el aviso. Si el token no tiene `notify:me`, se dijo aquí.
        let _ = api_post(
            &ctx.c,
            "/api/v1/notifications/self",
            json!({
                "title": format!("{playbook_id} en {}: {final_status}", ctx.name()),
                "body": format!("La petición {} quedó {final_status}.{hint}", a.grant),
            }),
        );
        return Ok(1);
    }
    Ok(0)
}

/// Abre la ejecución gastando la autorización, corre y la cierra. Devuelve
/// cómo acabó.
fn execute(ctx: &Context, effective: &Value, playbook_id: &str, grant: &str, seq: i64) -> Result<String, String> {
    let (spec, gaps) = ansible::plan_run(&ctx.folder, &ctx.manifest, playbook_id, effective)?;
    gaps.check()?;
    let target = spec.host.as_ref().map(|h| h.name.clone()).unwrap_or_default();
    // El backend compara el playbook con el de la autorización por su id.
    let started = api_post(
        &ctx.c,
        &format!("/api/v1/servers/{}/provisioning-runs", urlencode(&ctx.server_id)),
        json!({
            "kind": "playbook",
            "project": ctx.project,
            "playbook": playbook_id,
            "target": target,
            "varNames": spec.var_names(),
            "configSeq": seq,
            "requestId": grant,
        }),
    )?;
    let backend_run = started["id"].as_str().unwrap_or_default().to_string();
    let finish = |status: &str, code: Option<i32>, summary: String, tail: String| {
        let _ = api_patch(
            &ctx.c,
            &format!("/api/v1/servers/{}/provisioning-runs/{}", urlencode(&ctx.server_id), urlencode(&backend_run)),
            json!({ "status": status, "exitCode": code, "summary": summary, "logTail": tail }),
        );
    };
    let (code, cancelled, l) = match play(spec, true) {
        Ok(r) => r,
        Err(e) => {
            finish("failed", None, e.clone(), String::new());
            return Err(e);
        }
    };
    let status = if cancelled { "cancelled" } else if code == Some(0) { "succeeded" } else { "failed" };
    finish(status, code, play_recap(&l), log_tail(&l, 200));
    Ok(status.to_string())
}

fn print_request(r: &Value) {
    println!(
        "cac provision: petición {} · {} ({}) → `{}`",
        r["id"].as_str().unwrap_or("?"),
        r["playbook"].as_str().unwrap_or("?"),
        r["risk"].as_str().unwrap_or("?"),
        r["status"].as_str().unwrap_or("?"),
    );
    for f in r["flags"].as_array().cloned().unwrap_or_default() {
        println!(
            "  [{}] {} {}",
            f["level"].as_str().unwrap_or(""),
            f["code"].as_str().unwrap_or(""),
            f["detail"].as_str().unwrap_or("")
        );
    }
    match r["status"].as_str() {
        Some("approved") => println!(
            "pre-autorizada (lectura limpia). Corre con: cac provision run --server {} --grant {}",
            r["serverId"].as_str().unwrap_or("?"),
            r["id"].as_str().unwrap_or("?")
        ),
        Some("awaiting_approval") => {
            println!("espera la aprobación de una persona en la app (Servidores → Provisioning → Peticiones)")
        }
        _ => {}
    }
}

/// Lo que dijo un ensayo, en la forma de `domain.ProvisioningCheck`: los hosts
/// y totales del recap, las tareas que cambiarían, los ficheros de los diffs y
/// el texto de esas tareas (ya tachado: viene de `run_playbook`).
pub fn check_report(lines: &[String], exit_code: i32) -> Value {
    let clean: Vec<String> = lines.iter().map(|l| strip_ansi(l)).collect();
    let (mut hosts, mut ok, mut changed, mut unreachable, mut failed) = (Vec::<String>::new(), 0, 0, 0, 0);
    let mut changed_tasks: Vec<String> = Vec::new();
    let mut paths: Vec<String> = Vec::new();
    let mut diff = String::new();

    let mut in_recap = false;
    let mut task = String::new();
    let mut section: Vec<String> = Vec::new();
    let mut section_changed = false;
    let flush = |section: &mut Vec<String>, changed: &mut bool, diff: &mut String| {
        if *changed {
            diff.push_str(&section.join("\n"));
            diff.push('\n');
        }
        section.clear();
        *changed = false;
    };
    for l in &clean {
        if l.starts_with("PLAY RECAP") {
            flush(&mut section, &mut section_changed, &mut diff);
            in_recap = true;
            continue;
        }
        if in_recap {
            if let Some((host, rest)) = l.split_once(" : ") {
                hosts.push(host.trim().to_string());
                for kv in rest.split_whitespace() {
                    let (k, v) = kv.split_once('=').unwrap_or(("", "0"));
                    let n: i64 = v.parse().unwrap_or(0);
                    match k {
                        "ok" => ok += n,
                        "changed" => changed += n,
                        "unreachable" => unreachable += n,
                        "failed" => failed += n,
                        _ => {}
                    }
                }
            }
            continue;
        }
        if let Some(rest) = l.strip_prefix("TASK [") {
            flush(&mut section, &mut section_changed, &mut diff);
            task = rest.split(']').next().unwrap_or("").to_string();
        }
        if l.starts_with("changed:") && !task.is_empty() {
            section_changed = true;
            if !changed_tasks.contains(&task) {
                changed_tasks.push(task.clone());
            }
        }
        for prefix in ["--- before: ", "+++ after: "] {
            if let Some(p) = l.strip_prefix(prefix) {
                let p = p.trim().to_string();
                if !p.is_empty() && !paths.contains(&p) {
                    paths.push(p);
                }
            }
        }
        section.push(l.clone());
    }
    flush(&mut section, &mut section_changed, &mut diff);
    json!({
        "hosts": hosts,
        "ok": ok,
        "changed": changed,
        "unreachable": unreachable,
        "failed": failed,
        "changedTasks": changed_tasks,
        "paths": paths,
        "diff": diff,
        "exitCode": exit_code,
    })
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for d in chars.by_ref() {
                if d.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// El `PLAY RECAP` del final, sin color (como `playRecap` de la app).
pub fn play_recap(lines: &[String]) -> String {
    match lines.iter().rposition(|l| strip_ansi(l).starts_with("PLAY RECAP")) {
        Some(i) => lines[i..]
            .iter()
            .map(|l| strip_ansi(l))
            .filter(|l| !l.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        None => String::new(),
    }
}

pub fn log_tail(lines: &[String], n: usize) -> String {
    lines[lines.len().saturating_sub(n)..]
        .iter()
        .map(|l| strip_ansi(l))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn the_command_line_is_read_and_checked() {
        let a = parse_args(&s(&["cac", "provision", "request", "--server", "gstd", "--playbook", "swarm", "--folder", "infra/ansible", "--reason", "Traefik"])).unwrap();
        assert_eq!(
            a,
            CliArgs {
                action: "request".into(),
                server: "gstd".into(),
                playbook: "swarm".into(),
                folder: "infra/ansible".into(),
                reason: "Traefik".into(),
                grant: String::new(),
            }
        );
        assert_eq!(parse_args(&s(&["cac", "provision", "plan", "--server", "x", "--playbook", "y"])).unwrap().folder, ".");
        assert_eq!(parse_args(&s(&["cac", "provision", "run", "--server", "x", "--grant", "g1"])).unwrap().grant, "g1");
        assert!(parse_args(&s(&["cac", "provision", "apply", "--server", "x", "--playbook", "y"])).is_err());
        assert!(parse_args(&s(&["cac", "provision", "request", "--server", "x"])).is_err());
        assert!(parse_args(&s(&["cac", "provision", "run", "--server"])).is_err());
        assert!(parse_args(&s(&["cac", "provision", "run", "--server", "x", "--grant", "g", "--limit", "z"])).is_err());
    }

    // Correr es siempre con una autorización, y el playbook es el de ella:
    // `run` sin `--grant`, o con un `--playbook` que podría no ser el
    // aprobado, no se acepta. Roturas que atrapa: quitar cualquiera de las dos
    // guardas de `parse_args`.
    #[test]
    fn running_always_takes_a_grant_and_its_playbook() {
        let e = parse_args(&s(&["cac", "provision", "run", "--server", "gstd", "--playbook", "swarm"])).unwrap_err();
        assert!(e.contains("--grant"), "{e}");
        let e = parse_args(&s(&["cac", "provision", "run", "--server", "gstd", "--grant", "g1", "--playbook", "k8s"])).unwrap_err();
        assert!(e.contains("--playbook"), "{e}");
    }

    // Por id, o por un nombre que no se repite. Rotura que atrapa: quedarse
    // con el primero de dos que se llaman igual.
    #[test]
    fn a_server_is_picked_by_id_or_by_a_name_that_is_not_repeated() {
        let servers = json!([
            { "id": "a1", "name": "gstd" },
            { "id": "b2", "name": "dev" },
            { "id": "c3", "name": "dev" },
        ]);
        assert_eq!(pick_server(&servers, "gstd").unwrap()["id"], "a1");
        assert_eq!(pick_server(&servers, "c3").unwrap()["id"], "c3");
        assert!(pick_server(&servers, "dev").unwrap_err().contains("id"));
        assert!(pick_server(&servers, "nadie").is_err());
    }

    #[test]
    fn the_recap_and_the_tail_have_no_colour() {
        let l = s(&["TASK [x]", "ok: [gstd]", "\x1b[0;32mPLAY RECAP\x1b[0m *****", "", "\x1b[0;33mgstd\x1b[0m : ok=3 changed=1"]);
        assert_eq!(play_recap(&l), "PLAY RECAP *****\ngstd : ok=3 changed=1");
        assert_eq!(log_tail(&l, 2), "\ngstd : ok=3 changed=1");
        assert_eq!(play_recap(&s(&["nada"])), "");
    }

    // El ensayo, leído como lo evalúa cac: hosts y totales del recap, sólo las
    // tareas que cambiarían (con su diff y sus ficheros), y nada de las que
    // no. Roturas que atrapa: contar una tarea `ok` como cambio, perder la
    // ruta de un diff (es lo que levanta `touches-access`), o leer el recap
    // como tarea.
    #[test]
    fn a_dry_run_is_read_into_what_cac_evaluates() {
        let out = s(&[
            "PLAY [swarm] ****",
            "TASK [Gathering Facts] ****",
            "ok: [gstd]",
            "TASK [Instalar Traefik] ****",
            "--- before: /etc/traefik/traefik.yml",
            "+++ after: /etc/traefik/traefik.yml",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "\x1b[0;33mchanged: [gstd]\x1b[0m",
            "TASK [Abrir 443] ****",
            "ok: [gstd]",
            "TASK [Endurecer sshd] ****",
            // Con `template`, el `after` es la plantilla de esta máquina: la
            // ruta del servidor sólo viene en el `before`.
            "--- before: /etc/ssh/sshd_config",
            "+++ after: /home/x/.ansible/tmp/sshd_config.j2",
            "changed: [gstd]",
            "PLAY RECAP ****",
            "gstd : ok=4 changed=2 unreachable=0 failed=0 skipped=1",
        ]);
        let r = check_report(&out, 0);
        assert_eq!(r["hosts"], json!(["gstd"]));
        assert_eq!((r["ok"].as_i64(), r["changed"].as_i64(), r["failed"].as_i64()), (Some(4), Some(2), Some(0)));
        assert_eq!(r["changedTasks"], json!(["Instalar Traefik", "Endurecer sshd"]));
        assert_eq!(r["paths"], json!(["/etc/traefik/traefik.yml", "/etc/ssh/sshd_config", "/home/x/.ansible/tmp/sshd_config.j2"]));
        let diff = r["diff"].as_str().unwrap();
        assert!(diff.contains("+new") && diff.contains("Endurecer sshd"), "{diff}");
        assert!(!diff.contains("Abrir 443") && !diff.contains("Gathering"), "{diff}");
        assert_eq!(r["exitCode"], 0);

        // Uno que no llega: el host está en el recap con unreachable.
        let r = check_report(&s(&["PLAY RECAP ****", "gstd : ok=0 changed=0 unreachable=1 failed=0"]), 4);
        assert_eq!((r["unreachable"].as_i64(), r["exitCode"].as_i64()), (Some(1), Some(4)));
        // Sin recap, ningún host: cac lo marca (host-count).
        assert_eq!(check_report(&s(&["ERROR! nada"]), 1)["hosts"], json!([]));
    }

    // `request` es la que usa el MCP: tiene que ensayar siempre. Se comprueba
    // en el texto de la función, porque correrla necesita cac y un servidor:
    // ningún camino suyo llama a `play` sin pasar por `dry_run`, y `dry_run`
    // pone `check`. Rotura que atrapa: que `request` corra el spec tal cual.
    #[test]
    fn a_request_only_ever_dry_runs() {
        let src = include_str!("provision_cli.rs");
        let body = src
            .split("pub fn request(")
            .nth(1)
            .and_then(|r| r.split("\n}\n").next())
            .expect("request()");
        assert!(body.contains("dry_run(spec"), "request no ensaya");
        assert!(!body.contains("play(") && !body.contains("run_playbook") && !body.contains("execute("), "request corre algo de verdad");
        let dry = src.split("fn dry_run(").nth(1).and_then(|r| r.split("\n}\n").next()).unwrap();
        assert!(dry.contains("spec.check = true;"), "el ensayo no pone --check");
    }
}
