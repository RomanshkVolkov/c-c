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
//!
//! Dos formas de manifiesto. La v1 trae su inventario y sus referencias de
//! 1Password (los repos de cada cliente). La v2 (`infra/ansible`, desde el
//! 31-oct-2026) no trae ninguna de las dos: la config del servidor vive en cac,
//! y el inventario se genera aquí, de un solo host, con su conexión y sus
//! variables (`inventory_json`). El manifiesto v2 sólo dice qué variables pide
//! cada playbook y, de las secretas, el NOMBRE del secreto en la config del
//! servidor; un `op://` en él es un error.

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
    /// v1: el inventario del repo. v2: vacío, lo genera la app desde cac.
    #[serde(default)]
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
    /// v1: la referencia `op://` de la contraseña de sudo.
    #[serde(default, alias = "become_password_ref")]
    pub become_password_ref: Option<String>,
    /// v2: el NOMBRE del secreto de la config del servidor que es la
    /// contraseña de sudo (`OPS_PASSWORD`).
    #[serde(default, alias = "become_password_from")]
    pub become_password_from: Option<String>,
    #[serde(default)]
    pub vars: Vec<VarDef>,
    /// v2: `read`, `change` o `destructive`. Es lo que cac mira cuando un
    /// agente pide aplicarlo: sólo `read` puede ir pre-autorizado (decisión
    /// 4d28f4ab).
    #[serde(default)]
    pub risk: Option<String>,
    /// El playbook `read` que comprueba que salió bien.
    #[serde(default)]
    pub verify: Option<String>,
    /// El que lo deshace, o `manual`. Nunca corre solo.
    #[serde(default)]
    pub rollback: Option<String>,
}

pub const RISK_READ: &str = "read";
pub const RISK_CHANGE: &str = "change";
pub const RISK_DESTRUCTIVE: &str = "destructive";
/// Un rollback que no es un playbook: se arregla a mano (la consola del
/// proveedor). Dicho, no callado.
pub const ROLLBACK_MANUAL: &str = "manual";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VarDef {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// v1: una referencia `op://…`. v2: el NOMBRE de un secreto de la config
    /// del servidor (`CLOUDFLARE_DNS_TOKEN`). Las dos se leen en Rust al correr,
    /// y son secretas.
    #[serde(default)]
    pub from: Option<String>,
    /// v2: el valor por defecto, del que nace una plantilla. Nunca para una
    /// variable secreta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    /// Si lo que se escribe a mano es secreto (se tacha de la salida).
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub required: bool,
    /// v2: qué forma tiene el valor, cuando el default no lo dice (una
    /// variable obligatoria no lo trae). Hoy sólo `list`: la pantalla la pide
    /// una por línea, y una lista escrita como un texto suelto se vuelve
    /// lista al correr, porque un `join` de Jinja sobre un texto lo parte
    /// letra a letra.
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// Las formas que puede declarar una variable.
pub const VAR_KIND_LIST: &str = "list";

pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_yaml::from_str(text).map_err(|e| format!("{MANIFEST_FILE}: {e}"))?;
    if m.version != 1 && m.version != 2 {
        return Err(format!(
            "{MANIFEST_FILE}: unsupported version {}",
            m.version
        ));
    }
    let v2 = m.version == 2;
    if !v2 && m.inventory.is_empty() {
        return Err(format!("{MANIFEST_FILE}: version 1 needs its inventory"));
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
                let ok = if v2 { valid_secret_name(r) } else { r.starts_with("op://") };
                if !ok {
                    return Err(format!(
                        "{MANIFEST_FILE}: `{}` comes from `{r}`, which is not {}",
                        v.name,
                        if v2 { "the NAME of a secret of the server's config (the reference lives in cac)" } else { "op://" }
                    ));
                }
            }
            if v2 && (v.secret || v.from.is_some()) && v.default.is_some() {
                return Err(format!("{MANIFEST_FILE}: `{}` is secret and cannot have a default", v.name));
            }
            if let Some(k) = &v.kind {
                if k != VAR_KIND_LIST {
                    return Err(format!("{MANIFEST_FILE}: `{}` has type `{k}`; the only type is `list`", v.name));
                }
                if v.default.as_ref().is_some_and(|d| !d.is_array()) {
                    return Err(format!("{MANIFEST_FILE}: `{}` is a list and its default is not", v.name));
                }
            }
        }
        if let Some(r) = &p.become_password_ref {
            if v2 {
                return Err(format!(
                    "{MANIFEST_FILE}: version 2 names the sudo secret with become_password_from, not a reference"
                ));
            }
            if !r.starts_with("op://") {
                return Err(format!(
                    "{MANIFEST_FILE}: become password `{r}` is not op://"
                ));
            }
        }
        if let Some(n) = &p.become_password_from {
            if !v2 || !valid_secret_name(n) {
                return Err(format!(
                    "{MANIFEST_FILE}: become_password_from `{n}` is not the name of a secret (version 2)"
                ));
            }
        }
    }
    if v2 {
        check_risks(&m)?;
    }
    Ok(m)
}

/// Cada playbook de un manifiesto v2 declara su riesgo; los que cambian o
/// destruyen nombran un `verify` que es un playbook de lectura de este mismo
/// manifiesto y un `rollback` que es otro playbook de aquí o `manual`. Un
/// verify que cambia algo no verificaría: lo que comprobaría es lo que acaba
/// de tocar.
fn check_risks(m: &Manifest) -> Result<(), String> {
    let risk_of = |id: &str| m.playbooks.iter().find(|p| p.id == id).and_then(|p| p.risk.clone());
    for p in &m.playbooks {
        let risk = p.risk.as_deref().unwrap_or("");
        match risk {
            RISK_READ => {}
            RISK_CHANGE | RISK_DESTRUCTIVE => {
                let verify = p.verify.as_deref().ok_or_else(|| {
                    format!("{MANIFEST_FILE}: `{}` is {risk} and needs a `verify` playbook", p.id)
                })?;
                if risk_of(verify).as_deref() != Some(RISK_READ) {
                    return Err(format!(
                        "{MANIFEST_FILE}: the verify of `{}` (`{verify}`) is not a `read` playbook of this manifest",
                        p.id
                    ));
                }
                let rollback = p.rollback.as_deref().ok_or_else(|| {
                    format!("{MANIFEST_FILE}: `{}` is {risk} and needs a `rollback` (a playbook, or `manual`)", p.id)
                })?;
                if rollback != ROLLBACK_MANUAL && risk_of(rollback).is_none() {
                    return Err(format!(
                        "{MANIFEST_FILE}: the rollback of `{}` (`{rollback}`) is not a playbook of this manifest",
                        p.id
                    ));
                }
            }
            _ => {
                return Err(format!(
                    "{MANIFEST_FILE}: `{}` needs `risk: read`, `change` or `destructive`",
                    p.id
                ))
            }
        }
    }
    Ok(())
}

/// El nombre de un secreto en la config de un servidor, como lo valida cac
/// (`domain.SecretNamePattern`): `OPS_PASSWORD`.
pub fn valid_secret_name(s: &str) -> bool {
    let mut c = s.chars();
    matches!(c.next(), Some(ch) if ch.is_ascii_uppercase() || ch == '_')
        && c.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
        && s.len() <= 40
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
                become_password_from: None,
                vars: vec![],
                risk: None,
                verify: None,
                rollback: None,
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
    /// El inventario del repo (manifiesto v1). Con `host`, va vacío.
    #[serde(default)]
    pub inventory: String,
    /// El servidor, de la config de cac (manifiesto v2): el inventario se
    /// genera con él y sólo con él.
    #[serde(default)]
    pub host: Option<HostSpec>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub vars: Vec<RunVar>,
    /// Escrita a mano en la app. Sólo vive en memoria de Rust.
    #[serde(default)]
    pub become_password: Option<String>,
    #[serde(default)]
    pub become_password_ref: Option<String>,
    /// El ensayo: `--check --diff`. Ansible no cambia nada y dice qué
    /// cambiaría (paso 1 del protocolo).
    #[serde(default)]
    pub check: bool,
}

/// Un host del inventario generado: cómo se entra, a qué grupos pertenece (los
/// `hosts:` de los playbooks) y sus variables, ya combinadas en cac. **Ninguna
/// es secreta**: cac no deja guardar un secreto como variable, y aquí se
/// vuelve a comprobar (`validate`). Los secretos van por `vars`, al fichero
/// `0600`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostSpec {
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default)]
    pub vars: serde_json::Map<String, serde_json::Value>,
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
    match (&spec.host, spec.inventory.is_empty()) {
        (Some(_), false) => return Err("either the project's inventory or a host from cac, not both".into()),
        (None, true) => return Err("no inventory and no host to run against".into()),
        (None, false) if !inside_project(&spec.inventory) => {
            return Err(format!(
                "`{}` is not a file inside the project",
                spec.inventory
            ));
        }
        (Some(h), _) => validate_host(h)?,
        _ => {}
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

/// Lo que no puede llegar como variable de un host: secretos con el nombre que
/// lee Ansible. cac ya no deja guardarlos; esto es la segunda puerta.
const SECRET_HOST_VARS: [&str; 5] = [
    "ansible_become_password",
    "ansible_become_pass",
    "ansible_password",
    "ansible_ssh_pass",
    "ansible_ssh_password",
];

fn validate_host(h: &HostSpec) -> Result<(), String> {
    let name_ok = !h.name.is_empty()
        && h.name.len() <= 100
        && h.name.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    if !name_ok {
        return Err(format!("`{}` is not a host name", h.name));
    }
    // Una dirección, no una opción de ssh (`-oProxyCommand=…`).
    let addr_ok = !h.address.is_empty()
        && h.address.len() <= 255
        && !h.address.starts_with('-')
        && h.address.chars().all(|c| c.is_ascii_alphanumeric() || ".-:_".contains(c));
    if !addr_ok {
        return Err(format!("`{}` is not a host address", h.address));
    }
    if h.port == 0 {
        return Err("the ssh port can't be 0".into());
    }
    let user_ok = !h.user.is_empty()
        && h.user.len() <= 64
        && !h.user.starts_with('-')
        && h.user.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    if !user_ok {
        return Err(format!("`{}` is not a user name", h.user));
    }
    for g in &h.groups {
        if !valid_var_name(g) {
            return Err(format!("`{g}` is not a group name"));
        }
    }
    for k in h.vars.keys() {
        if !valid_var_name(k) {
            return Err(format!("`{k}` is not a variable name"));
        }
        if SECRET_HOST_VARS.contains(&k.to_ascii_lowercase().as_str()) {
            return Err(format!("`{k}` is a secret and can't travel as a host variable"));
        }
    }
    Ok(())
}

/// La variable de la config con las llaves públicas que entran al servidor.
/// Con ellas se elige qué llave ofrece `ssh` (ver `inventory_json`).
pub const AUTHORIZED_KEYS_VAR: &str = "ops_authorized_keys";

/// Las llaves públicas autorizadas del host, si la config las trae. Sólo
/// líneas de llave pública: nada que `ssh` pudiera leer como otra cosa.
pub fn authorized_keys(h: &HostSpec) -> Vec<String> {
    h.vars
        .get(AUTHORIZED_KEYS_VAR)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|k| k.as_str())
                .map(|k| k.trim().to_string())
                .filter(|k| (k.starts_with("ssh-") || k.starts_with("ecdsa-") || k.starts_with("sk-")) && !k.contains('\n'))
                .collect()
        })
        .unwrap_or_default()
}

/// El inventario de un solo host, en el formato que lee el plugin `yaml` de
/// Ansible (JSON vale).
///
/// **Qué llave se ofrece.** Por IP, `ssh` ofrece todas las llaves del agente de
/// 1Password, y el servidor corta antes de llegar a la buena («Too many
/// authentication failures»): lo tapaba el alias de `~/.ssh/config` con
/// `IdentitiesOnly`. Aquí se ofrecen sólo las llaves que el servidor autoriza
/// (`identity_files`: sus públicas, en ficheros; el agente firma con la
/// privada), salvo que la config ya diga sus propios argumentos de ssh. Sus variables van como variables del **host**, con la
/// misma precedencia que tenían en `host_vars/` y `group_vars/`: un `set_fact`
/// o el `vars:` de un play las pisan, como antes. Con `-e` no se podría (lo
/// pisaría todo, también la vuelta a root@22 de la etapa 1).
pub fn inventory_json(h: &HostSpec, identity_files: &[PathBuf]) -> String {
    use serde_json::{json, Value};
    let mut vars = serde_json::Map::new();
    vars.insert("ansible_host".into(), json!(h.address));
    vars.insert("ansible_port".into(), json!(h.port));
    vars.insert("ansible_user".into(), json!(h.user));
    if !identity_files.is_empty() {
        let mut args = vec!["-o IdentitiesOnly=yes".to_string()];
        args.extend(identity_files.iter().map(|f| format!("-o IdentityFile={}", f.display())));
        vars.insert("ansible_ssh_extra_args".into(), json!(args.join(" ")));
    }
    // Lo de la config va encima: un `ansible_host` ahí es un alias de
    // `~/.ssh/config` elegido a propósito.
    for (k, v) in &h.vars {
        vars.insert(k.clone(), v.clone());
    }
    let mut hosts = serde_json::Map::new();
    hosts.insert(h.name.clone(), Value::Object(vars));
    let mut children = serde_json::Map::new();
    for g in h.groups.iter().filter(|g| g.as_str() != "all") {
        children.insert(g.clone(), json!({ "hosts": { h.name.clone(): {} } }));
    }
    json!({ "all": { "hosts": hosts, "children": children } }).to_string()
}

/// Los argumentos de `ansible-playbook`. Ningún valor: sólo dónde está el
/// fichero de variables. **Nunca** `--ask-become-pass`, que esperaría por un
/// teclado que aquí no hay. Con un inventario generado, `-i` es su fichero.
pub fn build_args(spec: &RunSpec, vars_file: &Path, inventory_file: Option<&Path>) -> Vec<String> {
    let inventory = match inventory_file {
        Some(p) => p.display().to_string(),
        None => spec.inventory.clone(),
    };
    let mut args = vec![spec.playbook.clone(), "-i".into(), inventory];
    if let Some(l) = spec.limit.as_ref().filter(|l| !l.is_empty()) {
        // Pegado con `=`: un valor nunca se lee como otra opción.
        args.push(format!("--limit={l}"));
    }
    args.push("-e".into());
    args.push(format!("@{}", vars_file.display()));
    if spec.check {
        args.push("--check".into());
        args.push("--diff".into());
    }
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
    // El PATH de esta app, sin las carpetas de la AppImage (ver
    // `appimage_cleanup`).
    let own: Vec<(String, String)> = std::env::vars().collect();
    let base = appimage_cleanup(&own).1.or_else(|| std::env::var("PATH").ok());
    if let Some(p) = base.filter(|p| !p.is_empty()) {
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

/// Lo que la AppImage mete en el entorno y no puede llegar a Ansible: el
/// Python del venv heredaría `PYTHONHOME` y `PYTHONPATH` de la imagen y moriría
/// antes de empezar («Failed to import encodings module»). La limpieza vive en
/// `host.rs`, que la usa para todo lo que la app lanza.
pub use crate::host::appimage_cleanup;

fn without_appimage(cmd: &mut Command) {
    crate::host::clean(cmd);
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

// ─── Correr con la config de cac (manifiesto v2) ──────────────────────────────

/// Lo que falta para poder correr un playbook con la config de un servidor:
/// variables obligatorias sin valor y secretos sin referencia. Vacío = se puede.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanGaps {
    pub vars: Vec<String>,
    pub secrets: Vec<String>,
}

/// Un nombre de host para el inventario a partir del nombre del servidor en
/// cac, que puede llevar espacios o acentos («clúster»).
pub fn inventory_name(name: &str) -> String {
    let out: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "_.-".contains(c) { c } else { '-' })
        .collect();
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "server".into() } else { out }
}

/// De un playbook del manifiesto v2 y la config efectiva de un servidor (la
/// que da `GET /servers/{id}/config/effective`), lo que se corre: el host con
/// su conexión, sus variables (los defaults del manifiesto con la config
/// encima) y los secretos por referencia. Es la única receta: la usan la
/// pestaña Provisioning y `cac provision`, para que las dos apliquen lo mismo.
///
/// Devuelve también lo que falta; con algo faltando, `spec` no se corre.
pub fn plan_run(
    project_dir: &str,
    manifest: &Manifest,
    playbook_id: &str,
    effective: &serde_json::Value,
) -> Result<(RunSpec, PlanGaps), String> {
    if manifest.version != 2 {
        return Err(format!("{MANIFEST_FILE} is version {}: it carries its own inventory", manifest.version));
    }
    let pb = manifest
        .playbooks
        .iter()
        .find(|p| p.id == playbook_id)
        .ok_or_else(|| format!("`{playbook_id}` is not a playbook of {MANIFEST_FILE}"))?;
    let conn = effective.get("connection").ok_or("the effective config has no connection")?;
    let op_refs = effective.get("opRefs").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let ref_of = |name: &str| op_refs.get(name).and_then(|v| v.as_str()).map(str::to_string);

    let mut vars = serde_json::Map::new();
    for v in pb.vars.iter().filter(|v| !v.secret && v.from.is_none()) {
        if let Some(d) = &v.default {
            vars.insert(v.name.clone(), d.clone());
        }
    }
    if let Some(cfg) = effective.get("vars").and_then(|v| v.as_object()) {
        for (k, v) in cfg {
            vars.insert(k.clone(), v.clone());
        }
    }
    // Una lista que llegó como texto (una sola llave pegada en el JSON, o por
    // MCP) se vuelve lista: una por línea.
    for v in pb.vars.iter().filter(|v| v.kind.as_deref() == Some(VAR_KIND_LIST)) {
        if let Some(serde_json::Value::String(text)) = vars.get(&v.name) {
            let items: Vec<serde_json::Value> =
                text.lines().map(str::trim).filter(|l| !l.is_empty()).map(|l| serde_json::Value::String(l.into())).collect();
            vars.insert(v.name.clone(), serde_json::Value::Array(items));
        }
    }

    let mut gaps = PlanGaps::default();
    let mut run_vars = Vec::new();
    for v in &pb.vars {
        match &v.from {
            Some(name) => match ref_of(name) {
                Some(r) => run_vars.push(RunVar { name: v.name.clone(), value: None, from: Some(r), secret: true }),
                None => gaps.secrets.push(name.clone()),
            },
            None if v.required && !vars.contains_key(&v.name) => gaps.vars.push(v.name.clone()),
            None => {}
        }
    }
    let become_password_ref = match (&pb.become_, &pb.become_password_from) {
        (true, Some(name)) => match ref_of(name) {
            Some(r) => Some(r),
            None => {
                if !gaps.secrets.contains(name) {
                    gaps.secrets.push(name.clone());
                }
                None
            }
        },
        _ => None,
    };

    let host = HostSpec {
        name: inventory_name(conn.get("name").and_then(|v| v.as_str()).unwrap_or("")),
        address: conn.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        port: conn.get("sshPort").and_then(|v| v.as_u64()).unwrap_or(22) as u16,
        user: conn.get("sshUser").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        groups: pb.hosts.iter().cloned().collect(),
        vars,
    };
    let spec = RunSpec {
        project_dir: project_dir.to_string(),
        venv: manifest.venv.clone(),
        playbook: pb.file.clone(),
        inventory: String::new(),
        host: Some(host),
        limit: None,
        vars: run_vars,
        become_password: None,
        become_password_ref,
        check: false,
    };
    Ok((spec, gaps))
}

/// Qué le falta a la config de un servidor para correr un playbook (la
/// pestaña lo enseña antes de dejar apretar).
#[tauri::command]
pub fn ansible_plan_gaps(project_dir: String, playbook_id: String, effective: serde_json::Value) -> Result<PlanGaps, String> {
    let manifest = ansible_manifest(project_dir.clone())?;
    Ok(plan_run(&project_dir, &manifest, &playbook_id, &effective)?.1)
}

/// Corre un playbook con la config de cac de un servidor. Devuelve el id con
/// el que se cancela y los nombres de las variables (para el registro).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedRun {
    pub run_id: String,
    pub var_names: Vec<String>,
    pub target: String,
}

#[tauri::command]
pub async fn ansible_run_with_config(
    project_dir: String,
    playbook_id: String,
    effective: serde_json::Value,
    check: Option<bool>,
    on_event: Channel<AnsibleEvent>,
) -> Result<StartedRun, String> {
    let manifest = ansible_manifest(project_dir.clone())?;
    let (mut spec, gaps) = plan_run(&project_dir, &manifest, &playbook_id, &effective)?;
    gaps.check()?;
    // El ensayo del protocolo (`--check --diff`): la app lo corre antes de
    // pedir, igual que `cac provision request`.
    spec.check = check.unwrap_or(false);
    let var_names = spec.var_names();
    let target = spec.host.as_ref().map(|h| h.name.clone()).unwrap_or_default();
    let run_id = ansible_run(spec, on_event).await?;
    Ok(StartedRun { run_id, var_names, target })
}

/// Lee la salida de un ensayo como lo que cac evalúa: la misma lectura que
/// hace `cac provision request`, para que la app y la terminal manden lo mismo.
#[tauri::command]
pub fn ansible_check_report(lines: Vec<String>, exit_code: i32) -> serde_json::Value {
    crate::provision_cli::check_report(&lines, exit_code)
}

impl PlanGaps {
    /// Error con lo que falta, dicho para quien lo tiene que poner en cac.
    pub fn check(&self) -> Result<(), String> {
        let mut parts = Vec::new();
        if !self.vars.is_empty() {
            parts.push(format!("variables without a value: {}", self.vars.join(", ")));
        }
        if !self.secrets.is_empty() {
            parts.push(format!("secrets without a 1Password reference: {}", self.secrets.join(", ")));
        }
        if parts.is_empty() { Ok(()) } else { Err(format!("the server's config in cac is missing {}", parts.join("; "))) }
    }
}

impl RunSpec {
    /// Los nombres de lo que se le pasa al playbook, sin un valor: lo que se
    /// apunta en cac.
    pub fn var_names(&self) -> Vec<String> {
        let mut n: Vec<String> = self.vars.iter().map(|v| v.name.clone()).collect();
        if let Some(h) = &self.host {
            n.extend(h.vars.keys().cloned());
        }
        n.sort();
        n.dedup();
        n
    }
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
    let mut cmd = Command::new(bin);
    without_appimage(&mut cmd);
    let out = cmd
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

/// El fichero de variables (y el inventario generado): `0600`, y se borra al
/// soltarlo pase lo que pase. `.json` en el nombre: el plugin `yaml` de
/// inventario sólo lee esas extensiones.
struct VarsFile(PathBuf);

impl VarsFile {
    fn write(json: &str) -> Result<Self, String> {
        Self::write_named(json, "json")
    }

    fn write_named(text: &str, ext: &str) -> Result<Self, String> {
        use std::io::Write;
        let json = text;
        let path = std::env::temp_dir().join(format!("cac-ansible-{}.{ext}", uuid::Uuid::new_v4()));
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
pub async fn ansible_run(spec: RunSpec, on_event: Channel<AnsibleEvent>) -> Result<String, String> {
    run_playbook(spec, std::sync::Arc::new(move |e| {
        let _ = on_event.send(e);
    }))
}

/// A dónde va lo que pasa en una ejecución: el canal de la ventana, o la
/// salida de la terminal (`cac provision`).
pub type Sink = std::sync::Arc<dyn Fn(AnsibleEvent) + Send + Sync>;

/// El cuerpo de `ansible_run`, sin Tauri: la app y la terminal corren lo mismo.
pub fn run_playbook(spec: RunSpec, on_event: Sink) -> Result<String, String> {
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
    // Las llaves públicas que se ofrecen, en ficheros que viven lo que la
    // ejecución (no son secretas, pero no tienen por qué quedarse).
    let identity_files: Vec<VarsFile> = match &spec.host {
        Some(h) => authorized_keys(h)
            .iter()
            .map(|k| VarsFile::write_named(&format!("{k}\n"), "pub"))
            .collect::<Result<_, _>>()?,
        None => vec![],
    };
    let inventory_file = match &spec.host {
        Some(h) => {
            let paths: Vec<PathBuf> = identity_files.iter().map(|f| f.0.clone()).collect();
            Some(VarsFile::write(&inventory_json(h, &paths))?)
        }
        None => None,
    };
    let dirs = search_path(&project, spec.venv.as_deref());
    let bin = find_in(&dirs, "ansible-playbook")
        .ok_or("ansible-playbook not found (create the project's venv)")?;

    let mut cmd = Command::new(bin);
    without_appimage(&mut cmd);
    cmd.args(build_args(&spec, &vars_file.0, inventory_file.as_ref().map(|f| f.0.as_path())))
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
                ch(AnsibleEvent::Line {
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
        drop(inventory_file);
        drop(identity_files);
        let cancelled = runs(|m| m.remove(&run_id))
            .map(|r| r.cancelled)
            .unwrap_or(false);
        let code = status.ok().and_then(|s| s.code());
        on_event(AnsibleEvent::Exit { code, cancelled });
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
        let _ = crate::host::command("kill")
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
            host: None,
            limit: Some("tds".into()),
            vars: vec![],
            become_password: Some("contraseña-de-sudo".into()),
            become_password_ref: None,
            check: false,
        }
    }

    // Ninguna contraseña ni valor en la línea de comandos: se ve en `ps`.
    #[test]
    fn no_secret_and_no_value_goes_on_the_command_line() {
        let args = build_args(&spec(), Path::new("/tmp/vars.json"), None);
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

    // Lo que cac sabe aprovisionar (infra/ansible) es un manifiesto v2 que la
    // pestaña Provisioning y `cac provision` tienen que poder correr: que se
    // lea, que cada playbook exista dentro de la carpeta, que **ninguna**
    // referencia de 1Password viva en el repo (son de cada servidor, en cac),
    // y que cada secreto que pide un playbook se nombre igual en todos (una
    // plantilla los junta: `CLOUDFLARE_DNS_TOKEN` es uno solo).
    #[test]
    fn the_infra_ansible_manifest_is_one_the_app_can_run() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let text = std::fs::read_to_string(dir.join(MANIFEST_FILE)).unwrap();
        let m = parse_manifest(&text).unwrap();

        assert_eq!(m.version, 2);
        assert!(m.inventory.is_empty(), "el inventario lo genera cac");
        assert!(!text.contains("op://"), "una referencia de 1Password en el repo");
        assert!(!dir.join("inventory").exists(), "la config de los servidores vive en cac");
        assert!(!dir.join("secrets.env").exists(), "las referencias viven en cac");
        assert!(m.playbooks.len() >= 7);
        let mut secret_of: HashMap<&str, &str> = HashMap::new();
        for p in &m.playbooks {
            assert!(inside_project(&p.file), "{}", p.file);
            assert!(dir.join(&p.file).is_file(), "{} no existe", p.file);
            if p.become_ {
                assert!(p.become_password_from.is_some(), "{} hace sudo sin decir con qué secreto", p.id);
            }
            for v in &p.vars {
                if let Some(from) = &v.from {
                    assert!(v.secret, "{}.{} viene de un secreto y no se tacharía", p.id, v.name);
                    let prev = secret_of.insert(v.name.as_str(), from.as_str());
                    assert!(prev.is_none() || prev == Some(from.as_str()), "{} sale de dos secretos", v.name);
                }
            }
        }
    }

    // En un ensayo (`--check`) Ansible se salta `wait_for_connection`: sin
    // `check_mode: false`, la prueba de «¿se entra como dice el inventario?»
    // no corría, no se caía a root por el 22, y el ensayo de la etapa 1 iba
    // al puerto nuevo, que aún no existe (gstd, 2-nov-2026). Rotura que
    // atrapa: una prueba de conexión que vuelve a saltarse en el ensayo.
    #[test]
    fn a_connection_probe_also_runs_in_a_rehearsal() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible/playbooks");
        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let text = std::fs::read_to_string(&path).unwrap();
            let plays: Vec<serde_yaml::Value> = serde_yaml::from_str(&text).unwrap();
            for play in &plays {
                for list in ["pre_tasks", "tasks"] {
                    for task in play.get(list).and_then(|t| t.as_sequence()).into_iter().flatten() {
                        if task.get("ansible.builtin.wait_for_connection").is_some() {
                            seen += 1;
                            assert_eq!(
                                task.get("check_mode").and_then(|v| v.as_bool()),
                                Some(false),
                                "{}: «{}» se salta en el ensayo",
                                path.display(),
                                task.get("name").and_then(|n| n.as_str()).unwrap_or("?")
                            );
                        }
                    }
                }
            }
        }
        assert!(seen >= 2, "no se encontró ninguna prueba de conexión");
    }

    /// Todas las tareas de un fichero de Ansible (un playbook o las tareas de
    /// un rol), con las de dentro de `block`/`rescue`/`always`.
    fn ansible_tasks(text: &str) -> Vec<serde_yaml::Value> {
        fn walk(list: &serde_yaml::Value, out: &mut Vec<serde_yaml::Value>) {
            for t in list.as_sequence().into_iter().flatten() {
                for k in ["block", "rescue", "always"] {
                    if let Some(inner) = t.get(k) {
                        walk(inner, out);
                    }
                }
                out.push(t.clone());
            }
        }
        let doc: serde_yaml::Value = serde_yaml::from_str(text).unwrap();
        let mut out = Vec::new();
        let is_play = doc.as_sequence().and_then(|s| s.first()).is_some_and(|p| p.get("hosts").is_some());
        if is_play {
            for play in doc.as_sequence().unwrap() {
                for k in ["pre_tasks", "tasks", "post_tasks"] {
                    if let Some(l) = play.get(k) {
                        walk(l, &mut out);
                    }
                }
            }
        } else {
            walk(&doc, &mut out);
        }
        out
    }

    fn runs_in_rehearsal(t: &serde_yaml::Value) -> bool {
        t.get("check_mode").and_then(|v| v.as_bool()) == Some(false)
    }

    fn skipped_in_rehearsal(t: &serde_yaml::Value) -> bool {
        let when = match t.get("when") {
            Some(serde_yaml::Value::String(s)) => vec![s.clone()],
            Some(serde_yaml::Value::Sequence(l)) => l.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            _ => vec![],
        };
        when.iter().any(|w| w.contains("not ansible_check_mode"))
    }

    // En un ensayo (`--check`) `command`, `shell` y `uri` no corren. Una tarea
    // que reintenta hasta ver algo («Traefik en 1/1») reintentaba hasta
    // rendirse y tumbaba el ensayo de swarm (gstd, 2-nov-2026); y un playbook
    // de lectura ensayado no comprobaba nada. Roturas que atrapa: una espera
    // con `until` que corre en el ensayo sin poder ver nada; una lectura de un
    // playbook `read` que se salta en el ensayo.
    #[test]
    fn a_rehearsal_neither_waits_for_nothing_nor_skips_a_read() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let manifest = parse_manifest(&std::fs::read_to_string(root.join(MANIFEST_FILE)).unwrap()).unwrap();
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(root.join("playbooks")).unwrap().map(|e| e.unwrap().path()).collect();
        for role in std::fs::read_dir(root.join("roles")).unwrap() {
            let dir = role.unwrap().path().join("tasks");
            if dir.is_dir() {
                files.extend(std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()));
            }
        }
        let (mut waits, mut reads) = (0, 0);
        for path in files.iter().filter(|p| p.extension().is_some_and(|e| e == "yml")) {
            let rel = path.strip_prefix(&root).unwrap().to_string_lossy().to_string();
            let read_only = manifest.playbooks.iter().any(|p| p.file == rel && p.risk.as_deref() == Some(RISK_READ));
            for t in ansible_tasks(&std::fs::read_to_string(path).unwrap()) {
                let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("?").to_string();
                if t.get("until").is_some() {
                    waits += 1;
                    assert!(
                        runs_in_rehearsal(&t) || skipped_in_rehearsal(&t),
                        "{rel}: «{name}» reintenta, y en un ensayo su comando no corre: \
                         `when: not ansible_check_mode` si espera a algo que el ensayo no hace, \
                         `check_mode: false` si sólo lee"
                    );
                }
                let skipped_module = ["ansible.builtin.command", "ansible.builtin.shell", "ansible.builtin.uri"].iter().any(|m| t.get(*m).is_some());
                if read_only && skipped_module {
                    reads += 1;
                    assert!(runs_in_rehearsal(&t), "{rel}: «{name}» es una lectura y se saltaría en el ensayo: `check_mode: false`");
                }
            }
        }
        assert!(waits >= 5 && reads >= 8, "el recorrido no encontró las tareas ({waits} esperas, {reads} lecturas)");
    }

    // Un `ssh` que lanza un playbook (las comprobaciones de la etapa 1) no
    // pasa por la conexión de Ansible: sin `ansible_ssh_extra_args` ofrece
    // todas las llaves del agente y el sshd endurecido (MaxAuthTries 4) corta
    // antes de la buena. La etapa 1 se deshizo así estando bien (gstd,
    // 2-nov-2026). Rotura que atrapa: un `ssh` con llave sin esas llaves.
    #[test]
    fn a_playbooks_own_ssh_offers_the_servers_keys() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let mut seen = 0;
        for entry in std::fs::read_dir(root.join("playbooks")).unwrap() {
            let path = entry.unwrap().path();
            for t in ansible_tasks(&std::fs::read_to_string(&path).unwrap()) {
                let Some(cmd) = t.get("ansible.builtin.command").and_then(|c| c.as_str()) else { continue };
                if !cmd.trim_start().starts_with("ssh ") || cmd.contains("PubkeyAuthentication=no") {
                    continue;
                }
                seen += 1;
                assert!(
                    cmd.contains("ansible_ssh_extra_args"),
                    "{}: «{}» ofrecería todas las llaves del agente",
                    path.display(),
                    t.get("name").and_then(|n| n.as_str()).unwrap_or("?")
                );
            }
        }
        assert!(seen >= 2, "no se encontraron los ssh de la etapa 1");
    }

    // El deshacer de la etapa 1 borraba la configuración nueva y reiniciaba
    // sshd: si el puerto de antes venía de `ssh.socket` (que el cambio ya
    // había quitado), sshd volvía al 22, que el firewall no deja pasar, y
    // gstd se quedó sin SSH (2-nov-2026). Roturas que atrapa: un deshacer que
    // no vuelve a escuchar en el puerto por el que se entró, o que no
    // comprueba que escucha.
    #[test]
    fn undoing_the_ssh_change_keeps_the_port_it_came_in_by() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible/playbooks/server-baseline.yml");
        let plays: Vec<serde_yaml::Value> = serde_yaml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let block = plays[0]["tasks"].as_sequence().unwrap().iter().find(|t| t.get("rescue").is_some()).expect("el cambio de SSH tiene su deshacer");
        let rescue = serde_yaml::to_string(&block["rescue"]).unwrap();
        assert!(rescue.contains("Port {{ ansible_port"), "el deshacer no vuelve al puerto por el que se entró");
        let waits = block["rescue"].as_sequence().unwrap().iter().any(|t| {
            t.get("ansible.builtin.wait_for").and_then(|w| w.get("port")).and_then(|p| p.as_str()).is_some_and(|p| p.contains("ansible_port"))
        });
        assert!(waits, "el deshacer no comprueba que sshd escucha en ese puerto");
    }

    // Una etapa con wildcard por DNS crea sus registros (rol dns_records) y
    // declara lo que ese rol valida; y k8s, en un servidor sin clúster, se
    // ensaya hasta donde se puede ver. Antes k8s no creaba los registros, no
    // pedía dns_zone, y su ensayo fallaba con «No package matching
    // 'containerd.io'» (lo que el propio playbook instala antes; medido en un
    // Ubuntu 24.04 limpio, 2-nov-2026). Roturas que atrapa: una etapa sin sus
    // registros; un rol de DNS sin dns_zone o sin el token declarados; el
    // control plane o los addons ensayados sin clúster.
    #[test]
    fn a_dns_stage_makes_its_records_and_k8s_rehearses_what_it_can_see() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let manifest = parse_manifest(&std::fs::read_to_string(root.join(MANIFEST_FILE)).unwrap()).unwrap();
        let roles_of = |file: &str| -> Vec<serde_yaml::Value> {
            let plays: Vec<serde_yaml::Value> = serde_yaml::from_str(&std::fs::read_to_string(root.join(file)).unwrap()).unwrap();
            plays[0]["roles"].as_sequence().cloned().unwrap_or_default()
        };
        let name = |r: &serde_yaml::Value| r.as_str().map(str::to_string).or_else(|| r.get("role").and_then(|n| n.as_str()).map(str::to_string)).unwrap_or_default();
        for id in ["swarm", "k8s"] {
            let pb = manifest.playbooks.iter().find(|p| p.id == id).unwrap();
            assert!(roles_of(&pb.file).iter().any(|r| name(r) == "dns_records"), "{id} no crea sus registros DNS");
            for var in ["dns_zone", "base_domain", "public_ip"] {
                assert!(pb.vars.iter().any(|v| v.name == var && v.required), "{id} no pide {var}");
            }
            assert!(pb.vars.iter().any(|v| v.from.as_deref() == Some("CLOUDFLARE_DNS_TOKEN")), "{id} no declara el token de DNS");
        }
        let k8s = roles_of("playbooks/k8s-site.yml");
        for role in ["k8s_control_plane", "k8s_addons"] {
            let r = k8s.iter().find(|r| name(r) == role).unwrap();
            let when = r.get("when").and_then(|w| w.as_str()).unwrap_or("");
            assert!(when.contains("k8s_rehearsal_blind_cluster"), "{role} se ensaya sin clúster");
        }
        let node = std::fs::read_to_string(root.join("roles/k8s_node/tasks/main.yml")).unwrap();
        let tasks = ansible_tasks(&node);
        let packages = tasks.iter().find(|t| t.get("ansible.builtin.apt").is_some()).unwrap();
        assert!(serde_yaml::to_string(&packages["when"]).unwrap().contains("k8s_rehearsal_blind_install"), "los paquetes se ensayan sin su repo");
    }

    /// Las variables `ansible_<algo>` de un texto de Ansible.
    fn ansible_vars_in(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        let b = text.as_bytes();
        let mut i = 0;
        while let Some(pos) = text[i..].find("ansible_") {
            let start = i + pos;
            let boundary = start == 0 || !(b[start - 1].is_ascii_alphanumeric() || b[start - 1] == b'_' || b[start - 1] == b'.');
            let end = start + text[start..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(text.len() - start);
            if boundary {
                out.push(text[start..end].to_string());
            }
            i = end.max(start + 1);
        }
        out
    }

    // ansible-core 2.24 deja de inyectar los datos del servidor como
    // `ansible_<dato>`: hay que leerlos de `ansible_facts['…']`, y
    // `inject_facts_as_vars = False` hace que un uso viejo falle en vez de
    // avisar (los avisos de k8s, 2-nov-2026). Rotura que atrapa: un
    // `ansible_swaptotal_mb` o parecido que vuelve a un rol, o quitar el
    // ajuste del ansible.cfg.
    #[test]
    fn server_facts_are_read_from_ansible_facts() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let cfg = std::fs::read_to_string(root.join("ansible.cfg")).unwrap();
        assert!(cfg.lines().any(|l| l.split_whitespace().collect::<String>() == "inject_facts_as_vars=False"), "ansible.cfg vuelve a inyectar los datos del servidor");
        // Variables de conexión y mágicas: no son datos del servidor.
        let allowed = [
            "ansible_host", "ansible_port", "ansible_user", "ansible_check_mode", "ansible_playbook_python", "ansible_managed",
            "ansible_ssh_extra_args", "ansible_facts", "ansible_python_interpreter", "ansible_become_password", "ansible_connection",
        ];
        fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "yml" || x == "j2") {
                    out.push(p);
                }
            }
        }
        let mut files = Vec::new();
        walk(&root.join("roles"), &mut files);
        walk(&root.join("playbooks"), &mut files);
        for f in &files {
            let text = std::fs::read_to_string(f).unwrap();
            for line in text.lines().filter(|l| !l.trim_start().starts_with('#')) {
                for v in ansible_vars_in(line) {
                    assert!(allowed.contains(&v.as_str()), "{}: `{v}` es un dato del servidor: léelo de ansible_facts", f.display());
                }
            }
        }
    }

    // Un handler corre al FINAL del play: kubeadm init hablaba con el
    // containerd de antes, con el CRI apagado, y al repetir ni siquiera se
    // reiniciaba (la configuración ya estaba escrita). Rotura que atrapa:
    // quitar el flush antes de kubeadm, o la comprobación de que containerd
    // contesta por CRI.
    #[test]
    fn containerd_answers_by_cri_before_kubeadm() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let tasks = ansible_tasks(&std::fs::read_to_string(root.join("roles/k8s_node/tasks/main.yml")).unwrap());
        let pos = |pred: &dyn Fn(&serde_yaml::Value) -> bool| tasks.iter().position(|t| pred(t));
        let configure = pos(&|t| t.get("notify").and_then(|n| n.as_str()) == Some("Reiniciar containerd")).expect("configurar containerd");
        let flush = pos(&|t| t.get("ansible.builtin.meta").and_then(|m| m.as_str()) == Some("flush_handlers")).expect("el reinicio no se adelanta");
        assert!(flush > configure, "el flush va después de configurar containerd");
        let cri = pos(&|t| {
            t.get("ansible.builtin.command").and_then(|c| c.as_str()).is_some_and(|c| c.starts_with("crictl")) && t.get("until").is_some()
        })
        .expect("nada espera a que containerd conteste por CRI");
        assert!(cri > flush);
        let restart = pos(&|t| t.get("ansible.builtin.systemd_service").and_then(|s| s.get("state")).and_then(|s| s.as_str()) == Some("restarted"))
            .expect("sin reinicio cuando containerd no contesta por CRI");
        assert!(restart > flush && restart < cri);
    }

    // Con el ufw de la etapa 1, un pod no llegaba a la API (10.96.0.1 → la IP
    // del nodo, 6443): MetalLB se reiniciaba con `i/o timeout` y helm se
    // rendía (gstd, 2-nov-2026). Rotura que atrapa: un nodo de k8s que no
    // abre el firewall a la red de pods o a la de servicios.
    #[test]
    fn a_k8s_node_lets_its_own_networks_in() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let tasks = ansible_tasks(&std::fs::read_to_string(root.join("roles/k8s_node/tasks/main.yml")).unwrap());
        let ufw = tasks
            .iter()
            .find(|t| t.get("community.general.ufw").and_then(|u| u.get("from_ip")).is_some())
            .expect("el nodo no abre el firewall a las redes del clúster");
        assert_eq!(ufw["community.general.ufw"]["rule"].as_str(), Some("allow"));
        let items = serde_yaml::to_string(&ufw["loop"]).unwrap();
        for net in ["pod_cidr", "service_cidr"] {
            assert!(items.contains(net), "falta {net}");
        }
    }

    // cert-manager antes de 1.16.4 / 1.17.1 no puede borrar el TXT del reto
    // DNS en Cloudflare (`DELETE /zones//dns_records/…`, cert-manager#7540) y
    // el certificado no se emite nunca: gstd, 2-nov-2026, con la v1.14.0 de
    // pixel-vps. Rotura que atrapa: volver a una versión sin el arreglo.
    #[test]
    fn cert_manager_can_clean_its_cloudflare_challenge() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let m = parse_manifest(&std::fs::read_to_string(root.join(MANIFEST_FILE)).unwrap()).unwrap();
        let v = m.playbooks.iter().find(|p| p.id == "k8s").unwrap().vars.iter().find(|v| v.name == "cert_manager_version").unwrap();
        let tag = v.default.as_ref().and_then(|d| d.as_str()).unwrap().trim_start_matches('v').to_string();
        let n: Vec<u32> = tag.split('.').map(|x| x.parse().unwrap()).collect();
        let fixed = match (n[0], n[1]) {
            (1, m) if m < 16 => false,
            (1, 16) => n[2] >= 4,
            (1, 17) => n[2] >= 1,
            _ => true,
        };
        assert!(fixed, "cert-manager {tag} no puede limpiar el reto DNS en Cloudflare (cert-manager#7540)");
    }

    // Hasta el 3-nov-2026 sólo root leía el admin.conf: un `ssh gstd kubectl`
    // como el usuario de operación contestaba «connection refused» en
    // localhost:8080 y operar el clúster exigía sudo. Roturas que atrapa:
    // quitar la copia del kubeconfig al usuario de operación; dejársela de
    // otro dueño o legible por el grupo.
    #[test]
    fn the_ops_user_runs_kubectl_without_sudo() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let tasks = ansible_tasks(&std::fs::read_to_string(root.join("roles/k8s_control_plane/tasks/main.yml")).unwrap());
        let copy = tasks
            .iter()
            .filter_map(|t| t.get("ansible.builtin.copy"))
            .find(|c| {
                c.get("src").and_then(|s| s.as_str()) == Some("/etc/kubernetes/admin.conf")
                    && c.get("dest").and_then(|d| d.as_str()).is_some_and(|d| d.contains("{{ ops_user }}"))
            })
            .expect("el usuario de operación no recibe el admin.conf");
        assert_eq!(copy["owner"].as_str(), Some("{{ ops_user }}"), "el kubeconfig no es del usuario de operación");
        assert_eq!(copy["mode"].as_str(), Some("0600"), "el kubeconfig lo lee alguien más");
    }

    // Subir k8s_version a un parche nuevo sube los paquetes por apt, pero el
    // control plane son pods estáticos con la versión del init: sin
    // `kubeadm upgrade apply` queda un kubelet más nuevo que su apiserver, y
    // sin reiniciar kubelet sigue corriendo el binario viejo (gstd,
    // 3-nov-2026). Roturas que atrapa: quitar el upgrade; correrlo sin mirar
    // la versión que hay (cada pasada lo repetiría); no reiniciar kubelet.
    #[test]
    fn a_new_kubernetes_patch_upgrades_the_control_plane() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let tasks = ansible_tasks(&std::fs::read_to_string(root.join("roles/k8s_control_plane/tasks/main.yml")).unwrap());
        let when = |t: &serde_yaml::Value| serde_yaml::to_string(&t["when"]).unwrap_or_default();
        let upgrade = tasks
            .iter()
            .position(|t| t.get("ansible.builtin.command").and_then(|c| c.as_str()).is_some_and(|c| c.starts_with("kubeadm upgrade apply v{{ k8s_version }}")))
            .expect("un parche nuevo no sube el control plane");
        assert!(when(&tasks[upgrade]).contains("k8s_version"), "el upgrade no mira la versión que corre");
        let restart = tasks
            .iter()
            .position(|t| {
                let s = t.get("ansible.builtin.systemd_service");
                s.and_then(|s| s.get("name")).and_then(|n| n.as_str()) == Some("kubelet") && s.and_then(|s| s.get("state")).and_then(|n| n.as_str()) == Some("restarted")
            })
            .expect("kubelet no se reinicia con su versión nueva");
        assert!(restart > upgrade && when(&tasks[restart]).contains("k8s_version"));
    }

    // Sin una StorageClass por defecto un PVC se queda Pending y CNPG no
    // arranca; sin metrics-server `kubectl top` no contesta (pixel-vps,
    // 3-nov-2026). Roturas que atrapa: quitar el provisioner o dejar de
    // marcarlo por defecto; quitar metrics-server; una versión sin fijar en
    // el manifiesto.
    #[test]
    fn the_cluster_has_default_storage_and_metrics() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let m = parse_manifest(&std::fs::read_to_string(root.join(MANIFEST_FILE)).unwrap()).unwrap();
        let k8s = m.playbooks.iter().find(|p| p.id == "k8s").unwrap();
        for var in ["local_path_provisioner_version", "metrics_server_version"] {
            assert!(k8s.vars.iter().any(|v| v.name == var && v.default.is_some()), "k8s no fija {var}");
        }
        let tasks = ansible_tasks(&std::fs::read_to_string(root.join("roles/k8s_addons/tasks/main.yml")).unwrap());
        let command = |t: &serde_yaml::Value| t.get("ansible.builtin.command").and_then(|c| c.as_str()).unwrap_or("").to_string();
        assert!(
            tasks.iter().any(|t| t.get("ansible.builtin.get_url").and_then(|g| g.get("url")).and_then(|u| u.as_str()).is_some_and(|u| {
                u.contains("rancher/local-path-provisioner/{{ local_path_provisioner_version }}/")
            })),
            "el provisioner no se baja fijado a su versión"
        );
        assert!(tasks.iter().any(|t| command(t).contains("local-path-storage.yaml")), "el provisioner no se aplica");
        assert!(
            tasks.iter().any(|t| {
                let c = command(t);
                c.contains("patch storageclass local-path") && c.contains(r#""storageclass.kubernetes.io/is-default-class":"true""#)
            }),
            "local-path no es la StorageClass por defecto"
        );
        let metrics = tasks
            .iter()
            .filter_map(|t| t.get("kubernetes.core.helm"))
            .find(|h| h.get("name").and_then(|n| n.as_str()) == Some("metrics-server"))
            .expect("sin metrics-server");
        assert_eq!(metrics["chart_version"].as_str(), Some("{{ metrics_server_version }}"));
    }

    // Cada addon soporta una lista cerrada de menores de Kubernetes: las
    // tablas de compatibilidad río arriba, leídas el 3-nov-2026 (Cilium
    // 1.19: 1.32–1.35; Envoy Gateway 1.7 y 1.8: 1.32–1.35, 1.9: 1.33–1.36;
    // cert-manager 1.21: 1.33–1.36). Roturas que atrapa: subir k8s a un menor
    // que un addon no soporta; subir un addon a una línea que no soporta este
    // k8s, o a una que no está en la tabla (entonces se lee su tabla y se
    // añade la fila); y helm 4, con el que kubernetes.core.helm no está
    // probado.
    #[test]
    fn every_addon_supports_the_kubernetes_minor() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let m = parse_manifest(&std::fs::read_to_string(root.join(MANIFEST_FILE)).unwrap()).unwrap();
        let k8s = m.playbooks.iter().find(|p| p.id == "k8s").unwrap();
        let default = |name: &str| -> String {
            k8s.vars.iter().find(|v| v.name == name).and_then(|v| v.default.as_ref()).and_then(|d| d.as_str()).unwrap_or_else(|| panic!("sin {name}")).to_string()
        };
        let minor = default("k8s_minor");
        assert!(default("k8s_version").starts_with(&format!("{minor}.")), "k8s_version no es de la línea k8s_minor");
        let line = |v: &str| v.trim_start_matches('v').splitn(3, '.').take(2).collect::<Vec<_>>().join(".");
        let supported: &[(&str, &str, &[&str])] = &[
            ("cilium_version", "1.19", &["1.32", "1.33", "1.34", "1.35"]),
            ("envoy_gateway_version", "1.7", &["1.32", "1.33", "1.34", "1.35"]),
            ("envoy_gateway_version", "1.8", &["1.32", "1.33", "1.34", "1.35"]),
            ("envoy_gateway_version", "1.9", &["1.33", "1.34", "1.35", "1.36"]),
            ("cert_manager_version", "1.21", &["1.33", "1.34", "1.35", "1.36"]),
        ];
        for var in ["cilium_version", "envoy_gateway_version", "cert_manager_version"] {
            let v = default(var);
            let row = supported
                .iter()
                .find(|(name, l, _)| *name == var && *l == line(&v))
                .unwrap_or_else(|| panic!("{var} {v}: su línea no está en la tabla; lee su compatibilidad y añade la fila"));
            assert!(row.2.contains(&minor.as_str()), "{var} {v} no soporta Kubernetes {minor}");
        }
        assert!(default("helm_version").starts_with("v3."), "kubernetes.core.helm no está probado con helm 4");
    }

    // pixel-vps emite UN certificado con 13 dominios por HTTP-01: añadir uno
    // es editar un objeto que tocan varios proyectos y reemitir todo, y un
    // host que deja de apuntar al servidor rompe la renovación de los demás
    // (3-nov-2026). Aquí hay un Certificate por zona, por DNS-01, todos en el
    // listener https, y las rutas entran desde cualquier namespace. Roturas
    // que atrapa: volver a un certificado fuera del bucle; un listener que no
    // enumera todos los secretos; rutas sólo desde `default`; perder el
    // solver http01 (los dominios de fuera de la zona) o el selector del
    // dns01 (que lo intentaría con todo).
    #[test]
    fn a_certificate_per_zone_and_routes_from_any_namespace() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let m = parse_manifest(&std::fs::read_to_string(root.join(MANIFEST_FILE)).unwrap()).unwrap();
        let certs = m.playbooks.iter().find(|p| p.id == "k8s").unwrap().vars.iter().find(|v| v.name == "certificates").expect("k8s no declara certificates");
        assert_eq!(certs.kind.as_deref(), Some(VAR_KIND_LIST));
        let t = std::fs::read_to_string(root.join("roles/k8s_addons/templates/cluster.yaml.j2")).unwrap();
        let between = |a: &str, b: &str| -> String {
            let s = t.find(a).unwrap_or_else(|| panic!("falta `{a}`"));
            let e = t[s..].find(b).unwrap_or_else(|| panic!("falta `{b}` después de `{a}`"));
            t[s..s + e].to_string()
        };
        assert_eq!(t.matches("kind: Certificate").count(), 1, "más de un Certificate escrito a mano");
        assert!(between("{% for d in cert_domains %}\n---", "{% endfor %}").contains("kind: Certificate"), "el Certificate no sale del bucle de zonas");
        assert!(between("certificateRefs:", "allowedRoutes").contains("{% for d in cert_domains %}"), "el listener https no enumera todos los secretos");
        assert!(!t.contains("from: Same"), "las rutas sólo entran desde default");
        assert!(t.matches("from: All").count() >= 2, "http y https tienen que admitir rutas de cualquier namespace");
        let solvers = between("solvers:", "kind: Certificate");
        assert!(solvers.contains("dnsZones: [\"{{ dns_zone }}\"]"), "el solver dns01 no se limita a la zona");
        assert!(solvers.contains("dns01") && solvers.contains("http01"), "faltan solvers: dns01 para la zona, http01 para lo demás");
    }

    // Un wildcard de la zona (`*.guz-studio.dev`) como CERTIFICADO está bien;
    // como REGISTRO se llevó a gstd todo subdominio sin registro propio
    // (incidente 80e773bb). Roturas que atrapa: que dns_records cree registros
    // de `certificates`; que un dominio de `certificates` fuera de la zona
    // pase sin aviso (su wildcard iría al solver http01 y no saldría nunca).
    #[test]
    fn a_zone_certificate_makes_no_dns_record() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let dns = ansible_tasks(&std::fs::read_to_string(root.join("roles/dns_records/tasks/main.yml")).unwrap());
        let records = dns.iter().find(|t| t.get("community.general.cloudflare_dns").is_some()).expect("sin registros DNS");
        let items = serde_yaml::to_string(&records["loop"]).unwrap();
        assert!(items.contains("base_domain"), "los registros no son los de base_domain");
        for forbidden in ["certificates", "cert_domains", "dns_zone"] {
            assert!(!items.contains(forbidden), "dns_records crea registros de `{forbidden}`");
        }
        let addons = ansible_tasks(&std::fs::read_to_string(root.join("roles/k8s_addons/tasks/main.yml")).unwrap());
        let guard = addons
            .iter()
            .filter_map(|t| t.get("ansible.builtin.assert"))
            .find(|a| serde_yaml::to_string(&a["that"]).unwrap().contains("certificates"))
            .expect("nada comprueba que los dominios de certificates cuelgan de la zona");
        assert!(serde_yaml::to_string(&guard["that"]).unwrap().contains("dns_zone"));
    }

    // TURN y los puertos UDP de LiveKit son opcionales: un servidor sin voz
    // no abre nada. Y la verificación espera a TODOS los certificados, no
    // sólo al primero. Roturas que atrapa: el listener turn-tls sin su
    // guarda, o terminando el TLS; los puertos UDP sin su variable o por TCP;
    // un verify que sólo mira un certificado.
    #[test]
    fn turn_and_udp_are_opt_in_and_verify_waits_for_every_certificate() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/ansible");
        let t = std::fs::read_to_string(root.join("roles/k8s_addons/templates/cluster.yaml.j2")).unwrap();
        let guard = t.find("{% if livekit_turn_host").expect("el listener turn-tls no es opcional");
        let turn = t.find("name: turn-tls").expect("sin listener turn-tls");
        let end = t[turn..].find("{% endif %}").map(|e| turn + e).expect("el listener turn-tls no cierra su guarda");
        assert!(guard < turn && t[turn..end].contains("mode: Passthrough"), "el TURN no pasa entero por SNI");
        let base = ansible_tasks(&std::fs::read_to_string(root.join("roles/base/tasks/main.yml")).unwrap());
        let udp = base
            .iter()
            .filter_map(|t| t.get("community.general.ufw").map(|u| (u, t)))
            .find(|(u, _)| u.get("proto").and_then(|p| p.as_str()) == Some("udp"))
            .expect("el firewall no abre UDP");
        assert!(serde_yaml::to_string(&udp.1["loop"]).unwrap().contains("firewall_udp_ports"), "los puertos UDP no salen de la config");
        let verify = ansible_tasks(&std::fs::read_to_string(root.join("playbooks/k8s-verify.yml")).unwrap());
        assert!(
            verify.iter().any(|t| t.get("ansible.builtin.command").and_then(|c| c.as_str()).is_some_and(|c| c.contains("wait certificate --all"))),
            "la verificación no espera a todos los certificados"
        );
    }

    // v2: sin inventario y sin referencias. Roturas que atrapa: aceptar un
    // op:// en el manifiesto; un default en un secreto; become_password_ref en
    // v2; un nombre de secreto en minúsculas.
    #[test]
    fn a_v2_manifest_names_secrets_and_never_references_them() {
        let ok = "version: 2\nplaybooks:\n  - {id: swarm, risk: read, file: s.yml, name: S, become: true, become_password_from: OPS_PASSWORD, vars: [{name: tok, secret: true, from: CF_TOKEN}, {name: img, default: 'traefik:v3.6'}]}\n";
        let m = parse_manifest(ok).unwrap();
        assert_eq!(m.playbooks[0].become_password_from.as_deref(), Some("OPS_PASSWORD"));
        assert_eq!(m.playbooks[0].vars[1].default, Some(serde_json::json!("traefik:v3.6")));
        for bad in [
            "version: 2\nplaybooks:\n  - {id: a, risk: read, file: a.yml, name: a, vars: [{name: t, secret: true, from: 'op://v/i/f'}]}\n",
            "version: 2\nplaybooks:\n  - {id: a, risk: read, file: a.yml, name: a, vars: [{name: t, secret: true, from: cf_token}]}\n",
            "version: 2\nplaybooks:\n  - {id: a, risk: read, file: a.yml, name: a, vars: [{name: t, secret: true, from: CF, default: x}]}\n",
            "version: 2\nplaybooks:\n  - {id: a, risk: read, file: a.yml, name: a, become: true, become_password_ref: 'op://v/i/f'}\n",
            "version: 2\nplaybooks:\n  - {id: a, risk: read, file: a.yml, name: a, become: true, become_password_from: 'op://v/i/f'}\n",
            "version: 1\nplaybooks:\n  - {id: a, file: a.yml, name: a}\n",
        ] {
            assert!(parse_manifest(bad).is_err(), "{bad}");
        }
    }

    fn host() -> HostSpec {
        HostSpec {
            name: "gstd".into(),
            address: "13.140.235.112".into(),
            port: 7337,
            user: "infra_devops".into(),
            groups: vec!["swarm".into()],
            vars: serde_json::json!({ "base_domain": "gstd.guz-studio.dev", "ssh_port": 7337 })
                .as_object()
                .unwrap()
                .clone(),
        }
    }

    // El inventario generado: un host con su conexión y sus variables, en el
    // grupo del playbook. Roturas que atrapa: perder el grupo; que la
    // conexión pise un `ansible_host` puesto a propósito en la config.
    #[test]
    fn the_generated_inventory_is_one_host_in_its_group() {
        let inv: serde_json::Value = serde_json::from_str(&inventory_json(&host(), &[])).unwrap();
        let h = &inv["all"]["hosts"]["gstd"];
        assert_eq!(h["ansible_host"], "13.140.235.112");
        assert_eq!(h["ansible_port"], 7337);
        assert_eq!(h["ansible_user"], "infra_devops");
        assert_eq!(h["base_domain"], "gstd.guz-studio.dev");
        assert!(inv["all"]["children"]["swarm"]["hosts"].get("gstd").is_some());

        let mut alias = host();
        alias.vars.insert("ansible_host".into(), serde_json::json!("gstd"));
        let inv: serde_json::Value = serde_json::from_str(&inventory_json(&alias, &[])).unwrap();
        assert_eq!(inv["all"]["hosts"]["gstd"]["ansible_host"], "gstd");
    }

    // Por IP, ssh sólo ofrece las llaves que el servidor autoriza; si no, el
    // agente de 1Password ofrece todas y el servidor corta (medido en gstd el
    // 31-oct-2026: «Too many authentication failures»). Roturas que atrapa: no
    // poner IdentitiesOnly; aceptar como llave algo que no es una pública; que
    // la config no pueda poner sus propios argumentos de ssh.
    #[test]
    fn ssh_offers_only_the_keys_the_server_authorizes() {
        let mut h = host();
        h.vars.insert(
            AUTHORIZED_KEYS_VAR.into(),
            serde_json::json!(["ssh-ed25519 AAAA jose", "  ecdsa-sha2-nistp256 BBBB otra ", "-oProxyCommand=sh", 3]),
        );
        assert_eq!(authorized_keys(&h), vec!["ssh-ed25519 AAAA jose", "ecdsa-sha2-nistp256 BBBB otra"]);
        let files = [PathBuf::from("/tmp/a.pub"), PathBuf::from("/tmp/b.pub")];
        let inv: serde_json::Value = serde_json::from_str(&inventory_json(&h, &files)).unwrap();
        assert_eq!(
            inv["all"]["hosts"]["gstd"]["ansible_ssh_extra_args"],
            "-o IdentitiesOnly=yes -o IdentityFile=/tmp/a.pub -o IdentityFile=/tmp/b.pub"
        );
        h.vars.insert("ansible_ssh_extra_args".into(), serde_json::json!("-o IdentityAgent=none"));
        let inv: serde_json::Value = serde_json::from_str(&inventory_json(&h, &files)).unwrap();
        assert_eq!(inv["all"]["hosts"]["gstd"]["ansible_ssh_extra_args"], "-o IdentityAgent=none");
        let none: serde_json::Value = serde_json::from_str(&inventory_json(&host(), &[])).unwrap();
        assert!(none["all"]["hosts"]["gstd"].get("ansible_ssh_extra_args").is_none());
    }

    // Un host de cac no puede colar una opción de ssh, ni un secreto como
    // variable, ni venir junto con el inventario del repo.
    #[test]
    fn a_host_from_cac_is_checked_before_it_reaches_ssh() {
        let with = |f: &dyn Fn(&mut HostSpec)| {
            let mut s = spec();
            s.inventory = String::new();
            let mut h = host();
            f(&mut h);
            s.host = Some(h);
            validate(&s)
        };
        assert!(with(&|_| {}).is_ok());
        assert!(with(&|h| h.address = "-oProxyCommand=sh".into()).is_err());
        // Sólo caracteres de dirección, pero leído por ssh como una opción.
        assert!(with(&|h| h.address = "-p2222".into()).is_err());
        assert!(with(&|h| h.address = "1.2.3.4 -p 2".into()).is_err());
        assert!(with(&|h| h.user = "-l".into()).is_err());
        assert!(with(&|h| h.port = 0).is_err());
        assert!(with(&|h| h.groups = vec!["a b".into()]).is_err());
        assert!(with(&|h| { h.vars.insert("ansible_become_password".into(), serde_json::json!("x")); }).is_err());
        let mut both = spec();
        both.host = Some(host());
        assert!(validate(&both).is_err(), "inventario del repo y host de cac a la vez");
        let mut neither = spec();
        neither.inventory = String::new();
        assert!(validate(&neither).is_err());
    }

    fn v2() -> Manifest {
        parse_manifest(
            r#"
version: 2
venv: .venv
playbooks:
  - id: swarm
    file: playbooks/swarm-site.yml
    name: Swarm
    hosts: swarm
    risk: change
    verify: swarm-verify
    rollback: manual
    become: true
    become_password_from: OPS_PASSWORD
    vars:
      - { name: traefik_image, default: "traefik:v3.6" }
      - { name: base_domain, required: true }
      - { name: cloudflare_dns_token, secret: true, from: CLOUDFLARE_DNS_TOKEN }
  - { id: swarm-verify, file: playbooks/swarm-verify.yml, name: Verificar, hosts: swarm, risk: read }
"#,
        )
        .unwrap()
    }

    // Cada playbook v2 declara su riesgo; lo que cambia o destruye nombra un
    // verify de lectura de este manifiesto y un rollback (otro playbook, o
    // `manual`). Roturas que atrapa: aceptar un riesgo inventado o ausente,
    // un change sin verify o sin rollback, un verify que no es de lectura o
    // que no existe, y un rollback que no existe.
    #[test]
    fn every_v2_playbook_declares_its_risk() {
        let pb = |extra: &str| {
            format!(
                "version: 2\nplaybooks:\n  - {{id: v, file: v.yml, name: v, risk: read}}\n  - {{id: w, file: w.yml, name: w, risk: change, verify: v, rollback: manual}}\n  - {{id: a, file: a.yml, name: a{extra}}}\n"
            )
        };
        for ok in [", risk: read", ", risk: change, verify: v, rollback: manual", ", risk: destructive, verify: v, rollback: w"] {
            assert!(parse_manifest(&pb(ok)).is_ok(), "{ok}: {:?}", parse_manifest(&pb(ok)).err());
        }
        for bad in [
            "",
            ", risk: low",
            ", risk: change, rollback: manual",
            ", risk: change, verify: v",
            ", risk: change, verify: w, rollback: manual",
            ", risk: change, verify: nadie, rollback: manual",
            ", risk: destructive, verify: v, rollback: nadie",
        ] {
            assert!(parse_manifest(&pb(bad)).is_err(), "aceptó `{bad}`");
        }
        // Un manifiesto v1 sigue sin riesgos: es el de un repo de fuera, y
        // un agente no puede pedir nada con él.
        assert!(parse_manifest("version: 1\ninventory: i.ini\nplaybooks:\n  - {id: a, file: a.yml, name: a}\n").is_ok());
    }

    // El ensayo es el mismo comando con `--check --diff`, y sin ellos no se
    // ensaya. Rotura que atrapa: olvidar uno de los dos.
    #[test]
    fn a_dry_run_is_check_and_diff() {
        let mut s = spec();
        assert!(!build_args(&s, Path::new("/tmp/v.json"), None).iter().any(|a| a == "--check" || a == "--diff"));
        s.check = true;
        let args = build_args(&s, Path::new("/tmp/v.json"), None);
        assert!(args.contains(&"--check".to_string()) && args.contains(&"--diff".to_string()), "{args:?}");
    }

    /// La app ensaya con el mismo comando con el que aplica: lo que decide si
    /// es ensayo es el parámetro, y sin él no es ensayo. Si el comando
    /// ignorara el parámetro, «Ensayar» aplicaría de verdad.
    #[test]
    fn the_app_rehearses_through_the_check_parameter() {
        let src = include_str!("ansible.rs");
        let body = src.split("pub async fn ansible_run_with_config(").nth(1).and_then(|r| r.split("\n}\n").next()).unwrap();
        assert!(body.contains("spec.check = check.unwrap_or(false);"), "el ensayo de la app no llega a Rust");
    }

    fn effective() -> serde_json::Value {
        serde_json::json!({
            "configSeq": 4,
            "vars": { "base_domain": "gstd.guz-studio.dev", "traefik_image": "traefik:v3.7", "acme_email": "j@x" },
            "opRefs": {
                "OPS_PASSWORD": "op://Employee/gstd infra_devops/password",
                "CLOUDFLARE_DNS_TOKEN": "op://Employee/cf/credential"
            },
            "connection": { "name": "gstd (pruebas)", "host": "13.140.235.112", "sshPort": 7337, "sshUser": "infra_devops" }
        })
    }

    // La receta única: defaults del manifiesto con la config encima, secretos
    // por su referencia, sudo con la suya, y el host en el grupo del playbook.
    // Roturas que atrapa: los defaults encima de la config; un secreto que no
    // se tacharía; perder la contraseña de sudo; un nombre de servidor con
    // espacios llegando tal cual al inventario.
    #[test]
    fn a_run_is_planned_from_the_servers_config() {
        let (spec, gaps) = plan_run("/p", &v2(), "swarm", &effective()).unwrap();
        assert_eq!(gaps, PlanGaps::default());
        let h = spec.host.as_ref().unwrap();
        assert_eq!((h.name.as_str(), h.port, h.groups.clone()), ("gstd--pruebas", 7337, vec!["swarm".to_string()]));
        assert_eq!(h.vars["traefik_image"], "traefik:v3.7", "el default pisó a la config");
        assert_eq!(h.vars["acme_email"], "j@x");
        assert!(spec.inventory.is_empty());
        assert_eq!(spec.vars.len(), 1);
        assert_eq!(spec.vars[0].from.as_deref(), Some("op://Employee/cf/credential"));
        assert!(spec.vars[0].secret);
        assert_eq!(spec.become_password_ref.as_deref(), Some("op://Employee/gstd infra_devops/password"));
        assert!(validate(&spec).is_ok());
        assert!(!spec.var_names().iter().any(|n| n.contains("op://")));

        // Sin el token ni el dominio: se dice qué falta, y no se corre.
        let mut e = effective();
        e["opRefs"].as_object_mut().unwrap().remove("CLOUDFLARE_DNS_TOKEN");
        e["opRefs"].as_object_mut().unwrap().remove("OPS_PASSWORD");
        e["vars"].as_object_mut().unwrap().remove("base_domain");
        let (_, gaps) = plan_run("/p", &v2(), "swarm", &e).unwrap();
        assert_eq!(gaps.vars, vec!["base_domain"]);
        assert_eq!(gaps.secrets, vec!["CLOUDFLARE_DNS_TOKEN", "OPS_PASSWORD"]);
        assert!(gaps.check().is_err());
        assert!(plan_run("/p", &v2(), "nada", &effective()).is_err());
    }

    // Una lista declarada (`type: list`) que no trae default: las llaves SSH.
    // Roturas que atrapa: aceptar otro tipo, o un default que no es lista; y
    // dejar pasar una sola llave pegada como texto, que el `join('\n')` del
    // rol partiría letra a letra en el authorized_keys.
    #[test]
    fn a_list_written_as_text_becomes_a_list() {
        let m = parse_manifest(
            "version: 2\nplaybooks:\n  - {id: b, risk: read, file: b.yml, name: B, vars: [{name: keys, type: list, required: true}, {name: ports, default: [80]}]}\n",
        )
        .unwrap();
        assert_eq!(m.playbooks[0].vars[0].kind.as_deref(), Some("list"));
        for bad in [
            "version: 2\nplaybooks:\n  - {id: b, risk: read, file: b.yml, name: B, vars: [{name: k, type: lista}]}\n",
            "version: 2\nplaybooks:\n  - {id: b, risk: read, file: b.yml, name: B, vars: [{name: k, type: list, default: x}]}\n",
        ] {
            assert!(parse_manifest(bad).is_err(), "{bad}");
        }
        let plan = |keys: serde_json::Value| {
            let e = serde_json::json!({ "vars": { "keys": keys }, "connection": { "name": "s", "host": "h", "sshPort": 22, "sshUser": "u" } });
            plan_run("/p", &m, "b", &e).unwrap().0.host.unwrap().vars["keys"].clone()
        };
        assert_eq!(plan(serde_json::json!("ssh-ed25519 AAA a@b")), serde_json::json!(["ssh-ed25519 AAA a@b"]));
        assert_eq!(plan(serde_json::json!("ssh-ed25519 A\n\n ssh-rsa B \n")), serde_json::json!(["ssh-ed25519 A", "ssh-rsa B"]));
        assert_eq!(plan(serde_json::json!(["x", "y"])), serde_json::json!(["x", "y"]));
    }

    // Correr de verdad con un inventario generado: Ansible lo recibe por
    // `-i`, es 0600 y no sobrevive a la ejecución.
    #[cfg(unix)]
    #[test]
    fn a_generated_inventory_is_private_and_does_not_outlive_the_run() {
        use std::os::unix::fs::PermissionsExt;
        let inv = VarsFile::write(&inventory_json(&host(), &[])).unwrap();
        let vars = VarsFile::write(&vars_json(&[], None)).unwrap();
        let path = inv.0.clone();
        let mut s = spec();
        s.inventory = String::new();
        s.host = Some(host());
        let args = build_args(&s, &vars.0, Some(&inv.0));
        assert_eq!(args[1], "-i");
        assert_eq!(args[2], path.display().to_string());
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        drop(inv);
        assert!(!path.exists(), "el inventario generado sobrevivió");
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

    // Dentro de una AppImage, nada que apunte a la imagen llega a Ansible: con
    // su PYTHONHOME, el Python del venv no arranca.
    #[test]
    fn the_appimage_environment_does_not_reach_ansible() {
        let env: Vec<(String, String)> = [
            ("APPDIR", "/tmp/.mount_cac.Ab12/"),
            ("PYTHONHOME", "/tmp/.mount_cac.Ab12/usr/"),
            ("PYTHONPATH", "/tmp/.mount_cac.Ab12/usr/share/pyshared/"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_cac.Ab12/usr/lib/:/usr/lib"),
            ("PERLLIB", "/tmp/.mount_cac.Ab12/usr/share/perl5/"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
            ("PATH", "/tmp/.mount_cac.Ab12/usr/bin:/usr/local/bin:/usr/bin"),
            ("HOME", "/home/rv"),
            ("SSH_AUTH_SOCK", "/home/rv/.1password/agent.sock"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let (mut remove, path) = appimage_cleanup(&env);
        remove.sort();
        assert_eq!(
            remove,
            vec!["APPDIR", "LD_LIBRARY_PATH", "PERLLIB", "PYTHONDONTWRITEBYTECODE", "PYTHONHOME", "PYTHONPATH"]
        );
        assert_eq!(path.as_deref(), Some("/usr/local/bin:/usr/bin"));

        // Fuera de una AppImage no se toca nada.
        let plain: Vec<(String, String)> = vec![("PYTHONHOME".into(), "/opt/py".into()), ("PATH".into(), "/usr/bin".into())];
        assert_eq!(appimage_cleanup(&plain), (vec![], None));
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
            .args(build_args(&s, &vars.0, None))
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
