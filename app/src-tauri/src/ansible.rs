//! Ansible desde la app (R7 del módulo de servidores).
//!
//! Los playbooks corren **en esta máquina**: las llaves ssh las da el agente de
//! 1Password y los secretos se leen con `op read` aquí mismo. cac sólo apunta
//! que se corrió, quién, contra qué y cómo acabó; nunca un valor.
//!
//! Lo que no se negocia, y está probado abajo:
//! - Ningún secreto va en la línea de comandos (se ve en `ps`). Las variables y
//!   la contraseña de sudo viajan en un fichero `0600` que se pasa con
//!   `-e @fichero` y se borra al acabar.
//! - Lo que se lee de 1Password se lee en Rust y no llega a la pantalla: el
//!   valor entra en el conjunto de lo que se tacha de la salida.
//! - Un playbook o un inventario sólo pueden estar dentro del proyecto.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::Channel;

/// El fichero que describe un repo de Ansible para cac.
pub const MANIFEST_FILE: &str = "cac.playbooks.yml";

// ─── El manifest ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default = "one")]
    pub version: u32,
    /// El venv con `ansible-playbook`, relativo al proyecto (`.venv`).
    #[serde(default)]
    pub venv: Option<String>,
    pub inventory: String,
    pub playbooks: Vec<PlaybookDef>,
    /// true = no había manifest y esto se dedujo mirando el repo.
    #[serde(default, skip_deserializing)]
    pub discovered: bool,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookDef {
    pub id: String,
    pub file: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// El grupo o host que toca, informativo (el `hosts:` del playbook).
    #[serde(default)]
    pub hosts: Option<String>,
    /// Si pide sudo. Sin `become_password_ref`, la app la pregunta.
    #[serde(default, rename = "become")]
    pub become_: bool,
    #[serde(default, alias = "become_password_ref")]
    pub become_password_ref: Option<String>,
    #[serde(default)]
    pub vars: Vec<VarDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VarDef {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Una referencia `op://…`: se lee en Rust al correr, y es secreta.
    #[serde(default)]
    pub from: Option<String>,
    /// Si lo que se escribe a mano es secreto (se tacha de la salida).
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub required: bool,
}

pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_yaml::from_str(text).map_err(|e| format!("{MANIFEST_FILE}: {e}"))?;
    if m.version != 1 {
        return Err(format!(
            "{MANIFEST_FILE}: unsupported version {}",
            m.version
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for p in &m.playbooks {
        if !ids.insert(&p.id) {
            return Err(format!(
                "{MANIFEST_FILE}: playbook id `{}` is repeated",
                p.id
            ));
        }
        for v in &p.vars {
            if !valid_var_name(&v.name) {
                return Err(format!(
                    "{MANIFEST_FILE}: `{}` is not a variable name",
                    v.name
                ));
            }
            if let Some(r) = &v.from {
                if !r.starts_with("op://") {
                    return Err(format!(
                        "{MANIFEST_FILE}: `{}` comes from `{r}`, which is not op://",
                        v.name
                    ));
                }
            }
        }
        if let Some(r) = &p.become_password_ref {
            if !r.starts_with("op://") {
                return Err(format!(
                    "{MANIFEST_FILE}: become password `{r}` is not op://"
                ));
            }
        }
    }
    Ok(m)
}

pub fn valid_var_name(s: &str) -> bool {
    let mut c = s.chars();
    matches!(c.next(), Some(ch) if ch.is_ascii_alphabetic() || ch == '_')
        && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        && s.len() <= 120
}

/// Sin manifest: los `.yml` de las carpetas de playbooks de siempre, y el
/// inventario que diga `ansible.cfg` o el primero de los sitios habituales.
pub fn discover(project: &Path) -> Manifest {
    let mut playbooks = Vec::new();
    for dir in ["playbooks", "ansible/playbooks"] {
        let Ok(rd) = std::fs::read_dir(project.join(dir)) else {
            continue;
        };
        let mut files: Vec<String> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".yml") || n.ends_with(".yaml"))
            .collect();
        files.sort();
        for f in files {
            let stem = f
                .trim_end_matches(".yml")
                .trim_end_matches(".yaml")
                .to_string();
            playbooks.push(PlaybookDef {
                id: format!("{dir}/{stem}"),
                file: format!("{dir}/{f}"),
                name: stem,
                description: String::new(),
                hosts: None,
                become_: false,
                become_password_ref: None,
                vars: vec![],
            });
        }
    }
    let venv = [".venv", "venv"]
        .iter()
        .find(|v| project.join(v).join("bin").is_dir())
        .map(|v| v.to_string());
    Manifest {
        version: 1,
        venv,
        inventory: guess_inventory(project).unwrap_or_default(),
        playbooks,
        discovered: true,
    }
}

fn guess_inventory(project: &Path) -> Option<String> {
    if let Ok(cfg) = std::fs::read_to_string(project.join("ansible.cfg")) {
        for line in cfg.lines() {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("inventory") {
                if let Some(v) = rest.trim_start().strip_prefix('=') {
                    let v = v.trim();
                    if !v.is_empty() {
                        return Some(v.to_string());
                    }
                }
            }
        }
    }
    [
        "inventory.ini",
        "ansible/inventory.ini",
        "inventory/hosts.yml",
        "inventory/hosts.ini",
        "hosts",
        "inventory",
    ]
    .iter()
    .find(|p| project.join(p).exists())
    .map(|p| p.to_string())
}

// ─── Lo que se pide correr ────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    pub project_dir: String,
    #[serde(default)]
    pub venv: Option<String>,
    pub playbook: String,
    pub inventory: String,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub vars: Vec<RunVar>,
    /// Escrita a mano en la app. Sólo vive en memoria de Rust.
    #[serde(default)]
    pub become_password: Option<String>,
    #[serde(default)]
    pub become_password_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunVar {
    pub name: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub secret: bool,
}

/// Un camino relativo que no se sale del proyecto: sin `..`, sin raíz.
pub fn inside_project(rel: &str) -> bool {
    let p = Path::new(rel);
    !rel.is_empty()
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// Un `--limit` hecho de nombres y operadores de patrón de Ansible. Que no se
/// lea como otra opción lo garantiza `build_args`, que lo pega con `=`.
pub fn valid_limit(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-:,!&*[]".contains(c))
}

pub fn validate(spec: &RunSpec) -> Result<(), String> {
    if !Path::new(&spec.project_dir).is_absolute() {
        return Err("the project folder has to be an absolute path".into());
    }
    if !inside_project(&spec.playbook) {
        return Err(format!(
            "`{}` is not a file inside the project",
            spec.playbook
        ));
    }
    if !inside_project(&spec.inventory) {
        return Err(format!(
            "`{}` is not a file inside the project",
            spec.inventory
        ));
    }
    if let Some(v) = &spec.venv {
        if !inside_project(v) {
            return Err(format!("`{v}` is not a folder inside the project"));
        }
    }
    if let Some(l) = &spec.limit {
        if !valid_limit(l) {
            return Err(format!("`{l}` is not a host or group"));
        }
    }
    for v in &spec.vars {
        if !valid_var_name(&v.name) {
            return Err(format!("`{}` is not a variable name", v.name));
        }
        if let Some(r) = &v.from {
            if !r.starts_with("op://") {
                return Err(format!("`{}` comes from `{r}`, which is not op://", v.name));
            }
        }
    }
    Ok(())
}

/// Los argumentos de `ansible-playbook`. Ningún valor: sólo dónde está el
/// fichero de variables. **Nunca** `--ask-become-pass`, que esperaría por un
/// teclado que aquí no hay.
pub fn build_args(spec: &RunSpec, vars_file: &Path) -> Vec<String> {
    let mut args = vec![spec.playbook.clone(), "-i".into(), spec.inventory.clone()];
    if let Some(l) = spec.limit.as_ref().filter(|l| !l.is_empty()) {
        // Pegado con `=`: un valor nunca se lee como otra opción.
        args.push(format!("--limit={l}"));
    }
    args.push("-e".into());
    args.push(format!("@{}", vars_file.display()));
    args
}

/// El entorno: el venv delante en el PATH (con los sitios donde vive `op` en
/// una app abierta desde el escritorio, que no hereda el PATH de la shell), y
/// salida con color y sin búfer para verla en vivo.
pub fn build_env(
    project: &Path,
    venv: Option<&str>,
    agent_socket: Option<&str>,
) -> Vec<(String, String)> {
    let mut path: Vec<String> = Vec::new();
    if let Some(v) = venv {
        path.push(project.join(v).join("bin").to_string_lossy().into_owned());
    }
    path.extend(
        ["/opt/homebrew/bin", "/usr/local/bin"]
            .iter()
            .map(|s| s.to_string()),
    );
    if let Ok(p) = std::env::var("PATH") {
        path.push(p);
    }
    let mut env = vec![
        ("PATH".to_string(), path.join(":")),
        ("ANSIBLE_FORCE_COLOR".into(), "1".into()),
        ("PYTHONUNBUFFERED".into(), "1".into()),
        // Sin «¿confías en este host?» que nadie va a contestar.
        ("ANSIBLE_HOST_KEY_CHECKING".into(), "True".into()),
    ];
    if let Some(s) = agent_socket {
        env.push(("SSH_AUTH_SOCK".into(), s.to_string()));
    }
    env
}

/// Las variables, ya resueltas, como las lee `-e @fichero` (JSON vale).
pub fn vars_json(vars: &[(String, String)], become_password: Option<&str>) -> String {
    let mut m = serde_json::Map::new();
    for (k, v) in vars {
        m.insert(k.clone(), serde_json::Value::String(v.clone()));
    }
    if let Some(p) = become_password {
        m.insert(
            "ansible_become_password".into(),
            serde_json::Value::String(p.to_string()),
        );
    }
    serde_json::Value::Object(m).to_string()
}

/// Tacha los secretos de una línea de salida. Los de menos de cuatro
/// caracteres no se buscan: tacharían media salida sin proteger nada.
pub fn redact(line: &str, secrets: &[String]) -> String {
    let mut out = line.to_string();
    for s in secrets {
        if s.len() >= 4 {
            out = out.replace(s.as_str(), "***");
        }
    }
    out
}

// ─── Herramientas, manifest e inventario (comandos) ───────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnsibleTools {
    pub platform_supported: bool,
    pub reason: String,
    pub ansible_playbook: Option<String>,
    pub op: Option<String>,
}

fn find_in(dirs: &[PathBuf], name: &str) -> Option<String> {
    dirs.iter()
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

fn search_path(project: &Path, venv: Option<&str>) -> Vec<PathBuf> {
    build_env(project, venv, None)
        .into_iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.split(':').map(PathBuf::from).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn ansible_tools(project_dir: String, venv: Option<String>) -> AnsibleTools {
    if cfg!(windows) {
        return AnsibleTools {
            platform_supported: false,
            reason: "Ansible doesn't run on Windows; use WSL or another machine.".into(),
            ansible_playbook: None,
            op: None,
        };
    }
    let dirs = search_path(Path::new(&project_dir), venv.as_deref());
    AnsibleTools {
        platform_supported: true,
        reason: String::new(),
        ansible_playbook: find_in(&dirs, "ansible-playbook"),
        op: find_in(&dirs, "op"),
    }
}

/// El manifest del proyecto, o lo que se deduce del repo si no tiene.
#[tauri::command]
pub fn ansible_manifest(project_dir: String) -> Result<Manifest, String> {
    let project = Path::new(&project_dir);
    if !project.is_dir() {
        return Err(format!("{project_dir} is not a folder"));
    }
    match std::fs::read_to_string(project.join(MANIFEST_FILE)) {
        Ok(text) => parse_manifest(&text),
        Err(_) => Ok(discover(project)),
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InventoryHost {
    pub name: String,
    pub groups: Vec<String>,
    /// A dónde se conecta, si el inventario lo dice.
    pub ansible_host: Option<String>,
}

/// Sólo nombres, grupos y `ansible_host`: `--list` trae todas las variables de
/// cada host, y entre ellas puede haber una contraseña.
pub fn parse_inventory(json: &str) -> Result<Vec<InventoryHost>, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let obj = v.as_object().ok_or("inventory is not an object")?;
    let mut groups_of: HashMap<String, Vec<String>> = HashMap::new();
    for (group, body) in obj {
        if group == "_meta" {
            continue;
        }
        if let Some(hosts) = body.get("hosts").and_then(|h| h.as_array()) {
            for h in hosts.iter().filter_map(|h| h.as_str()) {
                groups_of
                    .entry(h.to_string())
                    .or_default()
                    .push(group.clone());
            }
        }
    }
    let hostvars = v.pointer("/_meta/hostvars").and_then(|h| h.as_object());
    let mut out: Vec<InventoryHost> = groups_of
        .into_iter()
        .map(|(name, mut groups)| {
            groups.sort();
            let ansible_host = hostvars
                .and_then(|hv| hv.get(&name))
                .and_then(|h| h.get("ansible_host"))
                .and_then(|h| h.as_str())
                .map(|s| s.to_string());
            InventoryHost {
                name,
                groups,
                ansible_host,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn ansible_inventory(
    project_dir: String,
    inventory: String,
    venv: Option<String>,
) -> Result<Vec<InventoryHost>, String> {
    if !inside_project(&inventory) {
        return Err(format!("`{inventory}` is not a file inside the project"));
    }
    let project = Path::new(&project_dir);
    let dirs = search_path(project, venv.as_deref());
    let bin = find_in(&dirs, "ansible-inventory").ok_or("ansible-inventory not found")?;
    let out = Command::new(bin)
        .args(["-i", &inventory, "--list"])
        .current_dir(project)
        .envs(build_env(project, venv.as_deref(), None))
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    parse_inventory(&String::from_utf8_lossy(&out.stdout))
}

// ─── Correr ───────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum AnsibleEvent {
    Line { stream: String, text: String },
    Exit { code: Option<i32>, cancelled: bool },
}

struct Running {
    pid: u32,
    cancelled: bool,
}

static RUNS: Mutex<Option<HashMap<String, Running>>> = Mutex::new(None);

fn runs<R>(f: impl FnOnce(&mut HashMap<String, Running>) -> R) -> R {
    let mut g = RUNS.lock().unwrap();
    f(g.get_or_insert_with(HashMap::new))
}

/// El fichero de variables: `0600`, y se borra al soltarlo pase lo que pase.
struct VarsFile(PathBuf);

impl VarsFile {
    fn write(json: &str) -> Result<Self, String> {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("cac-ansible-{}.json", uuid::Uuid::new_v4()));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&path).map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        Ok(VarsFile(path))
    }
}

impl Drop for VarsFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Corre un playbook y va contando la salida por el canal. Devuelve el id con
/// el que se cancela.
#[tauri::command]
pub fn ansible_run(spec: RunSpec, on_event: Channel<AnsibleEvent>) -> Result<String, String> {
    if cfg!(windows) {
        return Err("Ansible doesn't run on Windows".into());
    }
    validate(&spec)?;
    let project = PathBuf::from(&spec.project_dir);

    // Lo de 1Password se lee aquí, y todo lo secreto se tacha de la salida.
    let mut secrets: Vec<String> = Vec::new();
    let mut resolved: Vec<(String, String)> = Vec::new();
    for v in &spec.vars {
        let value = match (&v.from, &v.value) {
            (Some(r), _) => {
                let s = crate::op_read(r).map_err(|e| format!("{}: {e}", v.name))?;
                secrets.push(s.clone());
                s
            }
            (None, Some(val)) => {
                if v.secret {
                    secrets.push(val.clone());
                }
                val.clone()
            }
            (None, None) => continue,
        };
        resolved.push((v.name.clone(), value));
    }
    let become_pw = match (&spec.become_password_ref, &spec.become_password) {
        (Some(r), _) => Some(crate::op_read(r).map_err(|e| format!("become password: {e}"))?),
        (None, Some(p)) if !p.is_empty() => Some(p.clone()),
        _ => None,
    };
    if let Some(p) = &become_pw {
        secrets.push(p.clone());
    }

    let vars_file = VarsFile::write(&vars_json(&resolved, become_pw.as_deref()))?;
    let dirs = search_path(&project, spec.venv.as_deref());
    let bin = find_in(&dirs, "ansible-playbook")
        .ok_or("ansible-playbook not found (create the project's venv)")?;

    let mut cmd = Command::new(bin);
    cmd.args(build_args(&spec, &vars_file.0))
        .current_dir(&project)
        .envs(build_env(
            &project,
            spec.venv.as_deref(),
            crate::resolve_agent_socket().as_deref(),
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Su propio grupo de procesos: cancelar mata también los `ssh` y `sudo`
    // que lanza, que si no seguirían vivos.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    runs(|m| {
        m.insert(
            id.clone(),
            Running {
                pid: child.id(),
                cancelled: false,
            },
        )
    });

    let pumps: Vec<_> = [
        (
            "stdout",
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ),
        (
            "stderr",
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ),
    ]
    .into_iter()
    .filter_map(|(name, r)| r.map(|r| (name, r)))
    .map(|(name, r)| {
        let ch = on_event.clone();
        let secrets = secrets.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(r).lines().map_while(Result::ok) {
                let _ = ch.send(AnsibleEvent::Line {
                    stream: name.into(),
                    text: redact(&line, &secrets),
                });
            }
        })
    })
    .collect();

    let run_id = id.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        for p in pumps {
            let _ = p.join();
        }
        // El fichero con las variables se borra en cuanto ansible termina.
        drop(vars_file);
        let cancelled = runs(|m| m.remove(&run_id))
            .map(|r| r.cancelled)
            .unwrap_or(false);
        let code = status.ok().and_then(|s| s.code());
        let _ = on_event.send(AnsibleEvent::Exit { code, cancelled });
    });
    Ok(id)
}

/// Cancela una ejecución: el grupo entero, con `ssh` y `sudo` dentro.
#[tauri::command]
pub fn ansible_cancel(run_id: String) -> Result<(), String> {
    let pid = runs(|m| {
        m.get_mut(&run_id).map(|r| {
            r.cancelled = true;
            r.pid
        })
    })
    .ok_or("that run is not running")?;
    kill_group(pid);
    Ok(())
}

fn kill_group(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

/// Al cerrar la ventana: nada sigue tocando un servidor sin nadie mirando.
pub fn close_all() {
    let pids: Vec<u32> = runs(|m| m.values().map(|r| r.pid).collect());
    for pid in pids {
        kill_group(pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> RunSpec {
        RunSpec {
            project_dir: "/home/x/ansible".into(),
            venv: Some(".venv".into()),
            playbook: "ansible/playbooks/config-tds-rrhh.yml".into(),
            inventory: "ansible/inventory.ini".into(),
            limit: Some("tds".into()),
            vars: vec![],
            become_password: Some("contraseña-de-sudo".into()),
            become_password_ref: None,
        }
    }

    // Ninguna contraseña ni valor en la línea de comandos: se ve en `ps`.
    #[test]
    fn no_secret_and_no_value_goes_on_the_command_line() {
        let args = build_args(&spec(), Path::new("/tmp/vars.json"));
        assert_eq!(
            args,
            vec![
                "ansible/playbooks/config-tds-rrhh.yml",
                "-i",
                "ansible/inventory.ini",
                "--limit=tds",
                "-e",
                "@/tmp/vars.json"
            ]
        );
        assert!(!args
            .iter()
            .any(|a| a.contains("contraseña") || a.contains("ask-become")));
    }

    // La contraseña de sudo va en el fichero, con el nombre que lee Ansible.
    #[test]
    fn the_become_password_travels_in_the_vars_file() {
        let j: serde_json::Value = serde_json::from_str(&vars_json(
            &[("deploy_public_key".into(), "ssh-ed25519 AAA".into())],
            Some("pw"),
        ))
        .unwrap();
        assert_eq!(j["ansible_become_password"], "pw");
        assert_eq!(j["deploy_public_key"], "ssh-ed25519 AAA");
        let none: serde_json::Value = serde_json::from_str(&vars_json(&[], None)).unwrap();
        assert!(none.get("ansible_become_password").is_none());
    }

    #[test]
    fn secrets_are_struck_out_of_the_output() {
        let s = vec!["ghp_supersecreto".to_string(), "abc".to_string()];
        assert_eq!(
            redact("token=ghp_supersecreto y abc", &s),
            "token=*** y abc"
        );
    }

    // Nada fuera del proyecto, y ningún `--limit` que pase por opción.
    #[test]
    fn paths_stay_inside_the_project_and_limits_are_not_options() {
        assert!(inside_project("ansible/playbooks/x.yml"));
        assert!(inside_project("./site.yml"));
        assert!(!inside_project("../otro/x.yml"));
        assert!(!inside_project("/etc/passwd"));
        assert!(!inside_project("a/../../b.yml"));
        assert!(!inside_project(""));
        assert!(valid_limit("tds"));
        assert!(valid_limit("swarm:&web"));
        assert!(!valid_limit("x=y"));
        assert!(!valid_limit("tds; rm -rf /"));

        let mut s = spec();
        s.playbook = "../x.yml".into();
        assert!(validate(&s).is_err());
        let mut s = spec();
        s.vars = vec![RunVar {
            name: "x".into(),
            value: None,
            from: Some("https://evil".into()),
            secret: false,
        }];
        assert!(validate(&s).is_err());
        assert!(validate(&spec()).is_ok());
    }

    #[test]
    fn the_env_puts_the_venv_first_and_streams() {
        let env: HashMap<String, String> =
            build_env(Path::new("/p"), Some(".venv"), Some("/run/agent.sock"))
                .into_iter()
                .collect();
        assert!(env["PATH"].starts_with("/p/.venv/bin:"));
        assert_eq!(env["PYTHONUNBUFFERED"], "1");
        assert_eq!(env["SSH_AUTH_SOCK"], "/run/agent.sock");
        assert!(!env.contains_key("ANSIBLE_BECOME_PASS"));
    }

    #[test]
    fn a_manifest_is_read_and_checked() {
        let m = parse_manifest(
            r#"
version: 1
venv: .venv
inventory: ansible/inventory.ini
playbooks:
  - id: tds
    file: ansible/playbooks/config-tds-rrhh.yml
    name: Configurar tds-rh
    become: true
    become_password_ref: "op://Private/tds/password"
    vars:
      - name: deploy_public_key
        from: "op://dwit/tds_deploy_user/public key"
"#,
        )
        .unwrap();
        assert_eq!(
            m.playbooks[0].become_password_ref.as_deref(),
            Some("op://Private/tds/password")
        );
        assert!(m.playbooks[0].become_);
        assert_eq!(
            m.playbooks[0].vars[0].from.as_deref(),
            Some("op://dwit/tds_deploy_user/public key")
        );

        let bad = "version: 1\ninventory: i\nplaybooks:\n  - {id: a, file: a.yml, name: a, vars: [{name: x, from: 'https://x'}]}\n";
        assert!(parse_manifest(bad).is_err());
        let dup = "version: 1\ninventory: i\nplaybooks:\n  - {id: a, file: a.yml, name: a}\n  - {id: a, file: b.yml, name: b}\n";
        assert!(parse_manifest(dup).is_err());
    }

    // `--list` trae las variables de cada host; de ahí sólo salen nombres.
    #[test]
    fn the_inventory_returns_names_not_variables() {
        let hosts = parse_inventory(
            r#"{"_meta":{"hostvars":{"tds-rh":{"ansible_host":"tds","ansible_become_pass":"secreto"}}},
               "all":{"children":["tds","ungrouped"]},"tds":{"hosts":["tds-rh"]}}"#,
        )
        .unwrap();
        assert_eq!(
            hosts,
            vec![InventoryHost {
                name: "tds-rh".into(),
                groups: vec!["tds".into()],
                ansible_host: Some("tds".into())
            }]
        );
        assert!(!serde_json::to_string(&hosts).unwrap().contains("secreto"));
    }

    // Correr de verdad: la salida llega por líneas, tachada, y el fichero de
    // variables no sobrevive a la ejecución.
    #[cfg(unix)]
    #[test]
    fn a_real_run_streams_redacts_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("cac-ansible-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".venv/bin")).unwrap();
        // Un `ansible-playbook` falso que enseña lo que recibe y sale con 3.
        let fake = dir.join(".venv/bin/ansible-playbook");
        std::fs::write(&fake, "#!/bin/sh\necho \"args $*\"\nf=$(echo \"$*\" | sed 's/.*@//')\ncat \"$f\"; echo\necho err >&2\nexit 3\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut s = spec();
        s.project_dir = dir.to_string_lossy().into_owned();
        s.become_password = Some("sudo-secreto".into());
        let vars = VarsFile::write(&vars_json(&[], s.become_password.as_deref())).unwrap();
        let path = vars.0.clone();
        let out = Command::new(&fake)
            .args(build_args(&s, &vars.0))
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert_eq!(out.status.code(), Some(3));
        assert!(
            redact(&text, &["sudo-secreto".into()]).contains("\"ansible_become_password\":\"***\"")
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(vars);
        assert!(!path.exists(), "el fichero de variables sobrevivió");
        let _ = std::fs::remove_dir_all(dir);
    }
}
