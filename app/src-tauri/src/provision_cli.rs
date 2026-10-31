//! `cac provision`: aplicar un playbook desde una terminal con la config de cac.
//!
//! Es la misma receta que el botón de la pestaña Provisioning
//! (`ansible::plan_run` + `ansible::run_playbook`), para `make` y para un agente
//! que trabaja en la terminal de una persona. Corre en esta máquina: las llaves
//! SSH las da el agente de 1Password y los secretos se leen con `op read`, que
//! piden aprobación. A cac sólo le llega el registro de la ejecución (con el
//! token de `CAC_TOKEN`, que necesita `servers:manage`), nunca un valor.
//!
//! ```text
//! cac provision run --server gstd --playbook swarm [--folder infra/ansible]
//! cac provision plan --server gstd --playbook swarm [--folder …]
//! ```

use crate::ansible::{self, AnsibleEvent};
use crate::mcp::{api_get, api_patch, api_post, cfg, urlencode};
use serde_json::{json, Value};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

/// Lo que se pide por la línea de comandos.
#[derive(Debug, PartialEq)]
pub struct CliArgs {
    pub action: String,
    pub server: String,
    pub playbook: String,
    pub folder: String,
}

const USAGE: &str = "usage: cac provision <run|plan> --server <name or id> --playbook <id> [--folder <ansible project>]";

pub fn parse_args(args: &[String]) -> Result<CliArgs, String> {
    let mut it = args.iter().skip_while(|a| a.as_str() != "provision").skip(1);
    let action = it.next().cloned().ok_or(USAGE)?;
    if action != "run" && action != "plan" {
        return Err(USAGE.into());
    }
    let (mut server, mut playbook, mut folder) = (None, None, None);
    while let Some(flag) = it.next() {
        let val = it.next().cloned().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--server" => server = Some(val),
            "--playbook" => playbook = Some(val),
            "--folder" => folder = Some(val),
            _ => return Err(format!("unknown option {flag}\n{USAGE}")),
        }
    }
    Ok(CliArgs {
        action,
        server: server.ok_or(USAGE)?,
        playbook: playbook.ok_or(USAGE)?,
        folder: folder.unwrap_or_else(|| ".".into()),
    })
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

fn run(args: Vec<String>) -> Result<i32, String> {
    let a = parse_args(&args)?;
    let folder = std::fs::canonicalize(&a.folder).map_err(|e| format!("{}: {e}", a.folder))?;
    let folder_s = folder.to_string_lossy().into_owned();
    let manifest = ansible::ansible_manifest(folder_s.clone())?;
    let c = cfg()?;
    let server = pick_server(&api_get(&c, "/api/v1/servers")?, &a.server)?;
    let server_id = server["id"].as_str().unwrap_or_default().to_string();
    let effective = api_get(&c, &format!("/api/v1/servers/{}/config/effective", urlencode(&server_id)))?;
    let (spec, gaps) = ansible::plan_run(&folder_s, &manifest, &a.playbook, &effective)?;

    let config_seq = effective["configSeq"].as_i64().unwrap_or(0);
    println!(
        "cac provision: {} → {} (config v{config_seq}{})",
        a.playbook,
        server["name"].as_str().unwrap_or(&server_id),
        effective["templateName"].as_str().map(|t| format!(", plantilla «{t}»")).unwrap_or_default(),
    );
    if a.action == "plan" {
        // Sólo nombres: lo mismo que se apunta en cac.
        println!("variables: {}", spec.var_names().join(", "));
        return match gaps.check() {
            Ok(()) => {
                println!("listo para correr");
                Ok(0)
            }
            Err(e) => {
                println!("{e}");
                Ok(1)
            }
        };
    }
    gaps.check()?;

    let pb_file = spec.playbook.clone();
    let target = spec.host.as_ref().map(|h| h.name.clone()).unwrap_or_default();
    let started = api_post(
        &c,
        &format!("/api/v1/servers/{}/provisioning-runs", urlencode(&server_id)),
        json!({
            "kind": "playbook",
            "project": folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            "playbook": pb_file,
            "target": target,
            "varNames": spec.var_names(),
            "configSeq": config_seq,
        }),
    )?;
    let backend_run = started["id"].as_str().unwrap_or_default().to_string();

    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel::<(Option<i32>, bool)>();
    let sink_lines = lines.clone();
    let tx = Mutex::new(tx);
    let sink: ansible::Sink = Arc::new(move |e| match e {
        AnsibleEvent::Line { stream, text } => {
            if stream == "stderr" {
                eprintln!("{text}");
            } else {
                println!("{text}");
            }
            let mut l = sink_lines.lock().unwrap();
            l.push(text);
            let n = l.len();
            if n > 2000 {
                l.drain(..n - 2000);
            }
        }
        AnsibleEvent::Exit { code, cancelled } => {
            let _ = tx.lock().unwrap().send((code, cancelled));
        }
    });

    let finish = |status: &str, code: Option<i32>, summary: String, tail: String| {
        let _ = api_patch(
            &c,
            &format!("/api/v1/servers/{}/provisioning-runs/{}", urlencode(&server_id), urlencode(&backend_run)),
            json!({ "status": status, "exitCode": code, "summary": summary, "logTail": tail }),
        );
    };
    if let Err(e) = ansible::run_playbook(spec, sink) {
        finish("failed", None, e.clone(), String::new());
        return Err(e);
    }
    let (code, cancelled) = rx.recv().map_err(|e| e.to_string())?;
    let l = lines.lock().unwrap().clone();
    let status = if cancelled { "cancelled" } else if code == Some(0) { "succeeded" } else { "failed" };
    finish(status, code, play_recap(&l), log_tail(&l, 200));
    Ok(code.unwrap_or(1))
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
        let a = parse_args(&s(&["cac", "provision", "run", "--server", "gstd", "--playbook", "swarm", "--folder", "infra/ansible"])).unwrap();
        assert_eq!(a, CliArgs { action: "run".into(), server: "gstd".into(), playbook: "swarm".into(), folder: "infra/ansible".into() });
        assert_eq!(parse_args(&s(&["cac", "provision", "plan", "--server", "x", "--playbook", "y"])).unwrap().folder, ".");
        assert!(parse_args(&s(&["cac", "provision", "apply", "--server", "x", "--playbook", "y"])).is_err());
        assert!(parse_args(&s(&["cac", "provision", "run", "--server", "x"])).is_err());
        assert!(parse_args(&s(&["cac", "provision", "run", "--server"])).is_err());
        assert!(parse_args(&s(&["cac", "provision", "run", "--server", "x", "--playbook", "y", "--limit", "z"])).is_err());
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
}
