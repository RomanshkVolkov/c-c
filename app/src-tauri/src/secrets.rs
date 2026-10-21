//! Llevar los secrets de un servicio de 1Password al servidor (R8).
//!
//! Los valores se leen aquí, con `op read`, y viajan dentro de un guion que se
//! le pasa a `bash -s` por **stdin**: ni la línea de comandos de este lado ni
//! la del servidor los ven, y no tocan el disco. En el servidor el guion crea
//! un secret de Docker por valor —con nombre versionado por un HMAC cuya clave
//! sólo vive allí, como `rotate-secrets` de RRHH—, reapunta el servicio con
//! `service update` y sólo imprime **nombres**.
//!
//! Nada de esto vuelve a la pantalla con un valor dentro.

use serde::{Deserialize, Serialize};

use crate::agent_install::sh_quote;
use crate::{ssh_run_input, stage_public_key, stored_ssh_key};

/// Un nombre de servicio de Swarm, tal como lo acepta Docker.
fn valid_service(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

/// El nombre de un secret, que es también el de su fichero en `/run/secrets`.
/// Hasta 40: con `cac_` delante y la versión detrás cabe en los 64 de Docker.
pub fn valid_key(s: &str) -> bool {
    let mut c = s.chars();
    matches!(c.next(), Some(ch) if ch.is_ascii_uppercase() || ch == '_')
        && c.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
        && s.len() <= 40
}

/// El guion de la rotación. Cada valor aparece **una vez**, en su asignación
/// entre comillas simples, y se borra de la shell en cuanto se usa.
/// Sin secrets sólo del build: lo que prueban las pruebas de siempre.
#[cfg(test)]
pub fn rotation_script(service: &str, entries: &[(String, String)]) -> Result<String, String> {
    rotation_script_with(service, entries, &std::collections::HashSet::new())
}

/// Lo mismo, con los nombres que son **sólo del build** (build en el servidor,
/// v6): se crean como Docker secrets del servicio, con sus etiquetas, para que
/// el agente los monte en el job que construye, pero **no** se cuelgan del
/// servicio en marcha. Entran en lo que se guarda, así que la poda no se los
/// lleva.
pub fn rotation_script_with(
    service: &str,
    entries: &[(String, String)],
    build_only: &std::collections::HashSet<String>,
) -> Result<String, String> {
    if !valid_service(service) {
        return Err(format!("`{service}` is not a service name"));
    }
    if entries.is_empty() {
        return Err("nothing to rotate".into());
    }
    let mut seen = std::collections::HashSet::new();
    for (k, _) in entries {
        if !valid_key(k) {
            return Err(format!("`{k}` is not a secret name"));
        }
        if !seen.insert(k) {
            return Err(format!("`{k}` is repeated"));
        }
    }

    let mut s = String::new();
    s.push_str("set -euo pipefail\numask 077\n");
    s.push_str(&format!("SVC={}\n", sh_quote(service)));
    s.push_str(
        r#"fail() { echo "cac-secrets: $1" >&2; exit 2; }
docker service inspect "$SVC" >/dev/null 2>&1 || fail "service $SVC is not on this node"
command -v python3 >/dev/null || fail "python3 is needed for the version HMAC"
# La clave del HMAC de las versiones: sólo en este servidor, así el nombre del
# secret (que es público: docker secret ls, la spec del servicio) no revela el
# valor ni aunque sea uno corto y adivinable.
mkdir -p "$HOME/.cac" && chmod 700 "$HOME/.cac"
K="$HOME/.cac/secret-version.key"
[ -s "$K" ] || head -c 32 /dev/urandom > "$K"
chmod 600 "$K"
# Servicio y nombre van en el dato: dos variables con el mismo valor no
# comparten versión, que delataría que son iguales.
ver() { printf '%s\0%s\0%s' "$SVC" "$1" "$2" | python3 -c 'import hashlib,hmac,sys;print(hmac.new(open(sys.argv[1],"rb").read(),sys.stdin.buffer.read(),hashlib.sha256).hexdigest()[:16])' "$K"; }
CUR=$(docker service inspect "$SVC" --format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{.File.Name}} {{.SecretName}}{{"\n"}}{{end}}')
ARGS=()
KEEP=()
"#,
    );
    for (k, v) in entries {
        s.push_str(&format!("V={}\n", sh_quote(v)));
        if build_only.contains(k) {
            s.push_str(&format!(
                r#"N="cac_{k}_$(ver {k} "$V")"
if docker secret inspect "$N" >/dev/null 2>&1; then echo "same {k} $N"; else
  printf '%s' "$V" | docker secret create --label "cac.service=$SVC" --label "cac.key={k}" --label "cac.use=build" "$N" - >/dev/null
  echo "changed {k} $N"
fi
unset V
KEEP+=("$N")
"#
            ));
            continue;
        }
        s.push_str(&format!(
            r#"N="cac_{k}_$(ver {k} "$V")"
docker secret inspect "$N" >/dev/null 2>&1 || printf '%s' "$V" | docker secret create --label "cac.service=$SVC" --label "cac.key={k}" "$N" - >/dev/null
unset V
OLD=$(printf '%s\n' "$CUR" | awk -v t={k} '$1==t {{print $2}}')
KEEP+=("$N")
if [ "$OLD" != "$N" ]; then
  if [ -n "$OLD" ]; then ARGS+=(--secret-rm "$OLD"); KEEP+=("$OLD"); fi
  ARGS+=(--secret-add "source=$N,target={k}")
  echo "changed {k} $N"
else
  echo "same {k} $N"
fi
"#
        ));
    }
    s.push_str(
        r#"if [ ${#ARGS[@]} -gt 0 ]; then
  docker service update --detach=false --quiet "${ARGS[@]}" "$SVC" >/dev/null
  echo updated
fi
# Se queda lo puesto y lo de justo antes (un rollback de Swarm vuelve a él);
# lo más viejo de cac para este servicio se borra. Docker no deja borrar uno
# en uso, así que esto nunca tira nada que esté sirviendo.
for s in $(docker secret ls --filter "label=cac.service=$SVC" --format '{{.Name}}'); do
  keep=0
  for k in "${KEEP[@]}"; do [ "$k" = "$s" ] && keep=1; done
  [ "$keep" = 1 ] || docker secret rm "$s" >/dev/null 2>&1 || true
done
"#,
    );
    Ok(s)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RotatedSecret {
    pub name: String,
    /// El secret de Docker que quedó puesto (`cac_<NOMBRE>_<hmac16>`).
    pub secret: String,
    pub changed: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RotationResult {
    pub items: Vec<RotatedSecret>,
    /// Si el servicio se reinició con los nuevos.
    pub updated: bool,
}

/// Lo que se le pasa por stdin al comando de rotar del servidor (ver
/// `Deployable.RotateCommand`): `CLAVE=valor`, uno por línea, que es el
/// contrato de `rotate-secrets`. Lo que es sólo del build no va: ese comando
/// pone los secrets del servicio en marcha. Un valor con un salto de línea no
/// cabe en ese formato y se rechaza, nombrando la clave y nunca el valor.
pub fn rotate_command_input(entries: &[(String, String)], build_only: &std::collections::HashSet<String>) -> Result<String, String> {
    let mut s = String::new();
    for (name, value) in entries {
        if build_only.contains(name) {
            continue;
        }
        if value.contains('\n') || value.contains('\r') {
            return Err(format!("{name}: el valor tiene un salto de línea y el comando del servidor lee uno por línea"));
        }
        s.push_str(name);
        s.push('=');
        s.push_str(value);
        s.push('\n');
    }
    Ok(s)
}

/// Lee lo que imprime `rotate-secrets`: al final, `  CLAVE -> secret` por cada
/// uno vigente, y antes `creado <secret>` por los que son nuevos y
/// `actualizando …` si reinició el servicio. Como con la rotación propia, una
/// línea con otra forma se ignora: nunca se devuelve texto libre.
pub fn parse_rotate_command_output(out: &str) -> RotationResult {
    let created: std::collections::HashSet<&str> = out
        .lines()
        .filter_map(|l| l.trim().strip_prefix("creado "))
        .map(str::trim)
        .collect();
    let updated = out.lines().any(|l| l.trim_start().starts_with("actualizando "));
    let items = out
        .lines()
        .filter_map(|l| {
            let (name, secret) = l.trim().split_once(" -> ")?;
            let (name, secret) = (name.trim(), secret.trim());
            (valid_key(name) && !secret.is_empty() && secret.len() <= 80 && !secret.contains(char::is_whitespace)).then(|| RotatedSecret {
                name: name.to_string(),
                secret: secret.to_string(),
                changed: created.contains(secret),
            })
        })
        .collect();
    RotationResult { items, updated }
}

/// Lee lo que imprime el guion. Una línea que no tiene la forma esperada se
/// ignora: nunca se devuelve texto libre del servidor.
pub fn parse_rotation_output(out: &str) -> RotationResult {
    let mut items = Vec::new();
    let mut updated = false;
    for line in out.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.as_slice() {
            ["updated"] => updated = true,
            [kind @ ("changed" | "same"), name, secret]
                if valid_key(name) && secret.starts_with("cac_") && secret.len() <= 64 =>
            {
                items.push(RotatedSecret { name: name.to_string(), secret: secret.to_string(), changed: *kind == "changed" });
            }
            _ => {}
        }
    }
    RotationResult { items, updated }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub server_id: String,
    pub host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    pub name: String,
    pub op_ref: String,
    /// `runtime` (o nada), `build` o `both`. Ver `rotation_script_with`.
    #[serde(default)]
    pub usage: Option<String>,
}

/// El ítem de una referencia (`op://bóveda/ítem/…` → `op://bóveda/ítem`).
fn item_of(op_ref: &str) -> Option<String> {
    let rest = op_ref.strip_prefix("op://")?;
    let mut parts = rest.splitn(3, '/');
    let (vault, item) = (parts.next()?, parts.next()?);
    parts.next()?;
    Some(format!("op://{vault}/{item}"))
}

/// Los valores de las referencias que nombran un campo del ítem, por su
/// referencia exacta (`op item get` la trae en cada campo). Lo que no case se
/// queda fuera, y se lee luego campo a campo.
pub fn values_from_item(json: &str, refs: &[&str]) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return out };
    for f in v.get("fields").and_then(|f| f.as_array()).into_iter().flatten() {
        let (Some(r), Some(val)) = (f.get("reference").and_then(|x| x.as_str()), f.get("value").and_then(|x| x.as_str())) else {
            continue;
        };
        if refs.contains(&r) {
            out.insert(r.to_string(), val.to_string());
        }
    }
    out
}

/// Progreso de una rotación, para la pantalla (`secrets://rotation`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RotationProgress {
    /// `read` (1Password) o `upload` (servidor, y reiniciar el servicio).
    step: &'static str,
    done: usize,
    total: usize,
}

/// Lee cada referencia en 1Password y la lleva al servicio. Devuelve nombres.
///
/// **Un `op item get` por ítem**, no un `op read` por campo: casi todos los
/// secrets de un servicio están en el mismo ítem, y treinta llamadas a `op`
/// eran la mayor parte de lo que tardaba. Lo que no se resuelva así (otra
/// forma de escribir la referencia) se lee como antes. Y va contando por dónde
/// va: sin eso, el botón se quedaba quieto el rato y no se sabía si hacía algo.
#[tauri::command]
pub fn rotate_service_secrets(
    app: tauri::AppHandle,
    target: SshTarget,
    service: String,
    refs: Vec<SecretRef>,
    // De cada Environment de 1Password, dónde está montado en esta máquina
    // (para las referencias `op-env://`, ver `op_env`).
    env_files: Option<std::collections::HashMap<String, String>>,
    // El comando del servidor que recibe los secrets (ver
    // `Deployable.RotateCommand`). Con él, los valores van a ese comando por
    // stdin y no se usa la rotación propia de cac.
    command: Option<String>,
) -> Result<RotationResult, String> {
    use tauri::Emitter;
    let total = refs.len();
    let progress = |step: &'static str, done: usize| {
        let _ = app.emit("secrets://rotation", RotationProgress { step, done, total });
    };
    for r in &refs {
        if !r.op_ref.starts_with("op://") && crate::op_env::env_ref(&r.op_ref).is_none() {
            return Err(format!("{}: `{}` is not op:// nor op-env://", r.name, r.op_ref));
        }
    }
    progress("read", 0);
    // Primero lo de los Environments, del `.env` montado; luego los ítems.
    let env_files = env_files.unwrap_or_default();
    let env_refs: Vec<&str> = refs.iter().map(|r| r.op_ref.as_str()).filter(|r| r.starts_with("op-env://")).collect();
    let mut values: std::collections::HashMap<String, String> = crate::op_env::resolve(&env_refs, &env_files)?;
    let mut items: Vec<String> = refs.iter().filter_map(|r| item_of(&r.op_ref)).collect();
    items.sort();
    items.dedup();
    for item in &items {
        let Some((vault, name)) = item.trim_start_matches("op://").split_once('/') else { continue };
        let out = crate::host::command("op").args(["item", "get", name, "--vault", vault, "--format", "json"]).output();
        if let Some(o) = out.ok().filter(|o| o.status.success()) {
            let wanted: Vec<&str> = refs.iter().map(|r| r.op_ref.as_str()).filter(|r| r.starts_with(item.as_str())).collect();
            values.extend(values_from_item(&String::from_utf8_lossy(&o.stdout), &wanted));
            progress("read", refs.iter().filter(|r| values.contains_key(&r.op_ref)).count());
        }
    }
    let mut entries = Vec::with_capacity(refs.len());
    for r in &refs {
        let value = match values.remove(&r.op_ref) {
            Some(v) => v,
            None => crate::op_read(&r.op_ref).map_err(|e| format!("{}: {e}", r.name))?,
        };
        entries.push((r.name.clone(), value));
        progress("read", entries.len());
    }
    drop(values);
    progress("upload", total);
    let build_only: std::collections::HashSet<String> = refs
        .iter()
        .filter(|r| r.usage.as_deref() == Some("build"))
        .map(|r| r.name.clone())
        .collect();
    if let Some(cmd) = command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        if cmd.contains(['\n', '\r', '\0']) {
            return Err("el comando de rotar tiene que ser una línea".into());
        }
        let input = rotate_command_input(&entries, &build_only)?;
        drop(entries);
        let staged = match stored_ssh_key(&target.server_id).ok().flatten().filter(|k| !k.trim().is_empty()) {
            Some(k) => Some(stage_public_key(&k)?),
            None => None,
        };
        let identity = staged.as_ref().map(|s| s.path.to_string_lossy().into_owned());
        let out = ssh_run_input(&target.host, target.ssh_port, &target.ssh_user, cmd, identity.as_deref(), Some(&input))?;
        drop(input);
        return Ok(parse_rotate_command_output(&out.stdout));
    }
    let script = rotation_script_with(&service, &entries, &build_only)?;
    drop(entries);

    let staged = match stored_ssh_key(&target.server_id).ok().flatten().filter(|k| !k.trim().is_empty()) {
        Some(k) => Some(stage_public_key(&k)?),
        None => None,
    };
    let identity = staged.as_ref().map(|s| s.path.to_string_lossy().into_owned());
    // Si falla, el error trae el stderr del guion: sus mensajes no repiten
    // valores (`fail` sólo nombra servicio y herramientas), y docker no
    // imprime contenidos.
    let out = ssh_run_input(&target.host, target.ssh_port, &target.ssh_user, "bash -s", identity.as_deref(), Some(&script))?;
    Ok(parse_rotation_output(&out.stdout))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefCheck {
    pub op_ref: String,
    pub ok: bool,
    pub error: String,
}

/// «Probar»: lee cada referencia y descarta el valor. Dice si existe, nada más.
#[tauri::command]
pub fn check_op_refs(refs: Vec<String>, env_files: Option<std::collections::HashMap<String, String>>) -> Vec<RefCheck> {
    let env_files = env_files.unwrap_or_default();
    refs.into_iter()
        .map(|r| {
            let read = if r.starts_with("op-env://") {
                crate::op_env::resolve(&[r.as_str()], &env_files).map(|_| ())
            } else {
                crate::op_read(&r).map(|_| ())
            };
            (r, read)
        })
        .map(|(r, read)| match read {
            Ok(_) => RefCheck { op_ref: r, ok: true, error: String::new() },
            Err(e) => RefCheck { op_ref: r, ok: false, error: e },
        })
        .collect()
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemField {
    pub label: String,
    pub op_ref: String,
}

/// Las etiquetas y referencias de los campos de un ítem: lo que hace falta
/// para importarlo sin escribir cada referencia a mano. `op item get` trae
/// también los valores; de aquí no salen.
pub fn item_fields(json: &str) -> Result<Vec<ItemField>, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let fields = v.get("fields").and_then(|f| f.as_array()).ok_or("the item has no fields")?;
    Ok(fields
        .iter()
        .filter(|f| f.get("purpose").and_then(|p| p.as_str()) != Some("NOTES"))
        .filter_map(|f| {
            let label = f.get("label")?.as_str()?.to_string();
            let op_ref = f.get("reference")?.as_str()?.to_string();
            (!label.is_empty() && op_ref.starts_with("op://")).then_some(ItemField { label, op_ref })
        })
        .collect())
}

/// `op://bóveda/ítem` → los campos de ese ítem, sin valores.
#[tauri::command]
pub fn op_item_fields(item: String) -> Result<Vec<ItemField>, String> {
    let rest = item.strip_prefix("op://").ok_or("an item is op://vault/item")?;
    let (vault, name) = rest.split_once('/').ok_or("an item is op://vault/item")?;
    let name = name.trim_end_matches('/');
    if vault.is_empty() || name.is_empty() || name.contains('/') {
        return Err("an item is op://vault/item".into());
    }
    let out = crate::host::command("op")
        .args(["item", "get", name, "--vault", vault, "--format", "json"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    item_fields(&String::from_utf8_lossy(&out.stdout))
}

// ─── Capturar lo que ya corre (la primera vez) ────────────────────────────────
//
// Un servicio que pasa a desplegarse por cac ya tiene sus valores: el CI los
// puso como variables de entorno al desplegarlo, y en GitHub no se pueden leer
// de vuelta. Esto los lleva del servicio a un ítem nuevo de 1Password, con un
// campo por variable y su nombre exacto, para que desde ahí sean la fuente de
// verdad. Los valores van del servidor (por ssh) a 1Password (por la entrada
// estándar de `op`): no pasan por el backend, ni por la pantalla, ni por una
// línea de comandos. Lo que vuelve a la app son nombres.

/// El guion que lee el entorno del servicio. Sólo lee.
pub fn env_capture_script(service: &str) -> Result<String, String> {
    if !valid_service(service) {
        return Err(format!("`{service}` is not a service name"));
    }
    Ok(format!(
        "set -euo pipefail\nSVC={}\ndocker service inspect \"$SVC\" --format '{{{{json .Spec.TaskTemplate.ContainerSpec.Env}}}}'\n",
        sh_quote(service)
    ))
}

/// Las variables del servicio (`["NOMBRE=valor", …]`), sólo las que pueden
/// ser el nombre de un secret y sin repetir.
pub fn parse_service_env(json: &str) -> Result<Vec<(String, String)>, String> {
    let list: Option<Vec<String>> = serde_json::from_str(json.trim()).map_err(|_| "the service's environment is not readable".to_string())?;
    let mut out: Vec<(String, String)> = vec![];
    for kv in list.unwrap_or_default() {
        let Some((k, v)) = kv.split_once('=') else { continue };
        if valid_key(k) && !out.iter().any(|(n, _)| n == k) {
            out.push((k.to_string(), v.to_string()));
        }
    }
    Ok(out)
}

/// La plantilla del ítem, para la entrada estándar de `op item create`: una
/// nota segura con un campo oculto por variable, con la variable como nombre.
pub fn capture_template(title: &str, entries: &[(String, String)]) -> String {
    let fields: Vec<serde_json::Value> = entries
        .iter()
        .map(|(k, v)| serde_json::json!({ "id": k, "label": k, "type": "CONCEALED", "value": v }))
        .collect();
    serde_json::json!({ "title": title, "category": "SECURE_NOTE", "fields": fields }).to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// `op://bóveda/ítem`.
    pub item: String,
    pub names: Vec<String>,
}

/// Lee las variables del servicio y crea con ellas un ítem nuevo de
/// 1Password. Un ítem con ese nombre que ya exista no se toca: dos con el
/// mismo nombre harían ambiguas las referencias.
#[tauri::command]
pub fn capture_service_env(target: SshTarget, service: String, vault: String, title: String) -> Result<CaptureResult, String> {
    let (vault, title) = (vault.trim().to_string(), title.trim().to_string());
    if vault.is_empty() || title.is_empty() || title.contains('/') || vault.contains('/') {
        return Err("the vault and the item need a name, without /".into());
    }
    let exists = crate::host::command("op")
        .args(["item", "get", &title, "--vault", &vault, "--format", "json"])
        .output()
        .map_err(|e| e.to_string())?;
    if exists.status.success() {
        return Err(format!("1Password already has an item called «{title}» in {vault}; pick another name"));
    }

    let script = env_capture_script(&service)?;
    let staged = match stored_ssh_key(&target.server_id).ok().flatten().filter(|k| !k.trim().is_empty()) {
        Some(k) => Some(stage_public_key(&k)?),
        None => None,
    };
    let identity = staged.as_ref().map(|s| s.path.to_string_lossy().into_owned());
    let out = ssh_run_input(&target.host, target.ssh_port, &target.ssh_user, "bash -s", identity.as_deref(), Some(&script))?;
    let entries = parse_service_env(&out.stdout)?;
    if entries.is_empty() {
        return Err(format!("{service} has no environment variables to capture"));
    }

    use std::io::Write;
    let mut child = crate::host::command("op")
        .args(["item", "create", "--vault", &vault, "--format", "json", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("op has no stdin")?
        .write_all(capture_template(&title, &entries).as_bytes())
        .map_err(|e| e.to_string())?;
    let done = child.wait_with_output().map_err(|e| e.to_string())?;
    if !done.status.success() {
        // El error de `op` no repite valores: habla del ítem y de la sesión.
        return Err(String::from_utf8_lossy(&done.stderr).trim().to_string());
    }
    Ok(CaptureResult {
        item: format!("op://{vault}/{title}"),
        names: entries.into_iter().map(|(k, _)| k).collect(),
    })
}

// ─── La llave age de los backups (#166) ───────────────────────────────────────

/// Una llave age nueva: `(privada, pública)`. Es una X25519 en bech32, el
/// formato de age: la privada `AGE-SECRET-KEY-1…` (en mayúsculas) y la pública
/// `age1…`. Se genera en memoria y no se escribe en ningún sitio: va directa a
/// 1Password por la entrada estándar de `op`.
pub fn new_age_keypair() -> (String, String) {
    use bech32::ToBase32;
    use rand::RngCore;
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let secret = x25519_dalek::StaticSecret::from(raw);
    let public = x25519_dalek::PublicKey::from(&secret);
    let identity = bech32::encode("age-secret-key-", secret.to_bytes().to_base32(), bech32::Variant::Bech32)
        .expect("bech32 de 32 bytes")
        .to_uppercase();
    let recipient = bech32::encode("age", public.as_bytes().to_base32(), bech32::Variant::Bech32).expect("bech32 de 32 bytes");
    (identity, recipient)
}

/// El ítem de 1Password de una llave de backups: la privada en un campo
/// oculto, la pública a la vista (no es secreta) y una nota con cómo se usa.
pub fn backup_key_template(title: &str, identity: &str, recipient: &str) -> String {
    let note = format!(
        "Llave age de los backups de cac. La privada es lo único que abre los backups cifrados para {recipient}.\n\n\
         Abrir uno: age -d -i <(op read \"op://<bóveda>/{title}/private key\") fichero.age > backup"
    );
    serde_json::json!({
        "title": title,
        "category": "SECURE_NOTE",
        "fields": [
            { "id": "private_key", "label": "private key", "type": "CONCEALED", "value": identity },
            { "id": "public_key", "label": "public key", "type": "STRING", "value": recipient },
            { "id": "notesPlain", "label": "notesPlain", "type": "STRING", "purpose": "NOTES", "value": note }
        ]
    })
    .to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupKey {
    /// `op://bóveda/ítem`.
    pub item: String,
    pub public_key: String,
}

/// Crea una llave de backups directamente en 1Password y devuelve sólo la
/// pública, que la página registra en cac. La privada no pasa por el disco,
/// ni por la página, ni por la red: de la memoria de este proceso a `op`.
/// Un ítem con ese nombre que ya exista no se toca.
#[tauri::command]
pub fn create_backup_key(account: String, vault: String, title: String) -> Result<BackupKey, String> {
    let (vault, title) = (vault.trim().to_string(), title.trim().to_string());
    if vault.is_empty() || title.is_empty() || title.contains('/') || vault.contains('/') {
        return Err("the vault and the item need a name, without /".into());
    }
    // Con varias cuentas de 1Password (la personal y la del trabajo), sin
    // `--account` `op` elige una por su cuenta y la bóveda puede no estar ahí.
    let with_account = |args: &[&str]| -> Vec<String> {
        let mut v: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        if !account.trim().is_empty() {
            v.push("--account".into());
            v.push(account.trim().to_string());
        }
        v
    };
    let exists = crate::host::command("op")
        .args(with_account(&["item", "get", &title, "--vault", &vault, "--format", "json"]))
        .output()
        .map_err(|e| e.to_string())?;
    if exists.status.success() {
        return Err(format!("1Password already has an item called «{title}» in {vault}; pick another name"));
    }
    let (identity, recipient) = new_age_keypair();
    use std::io::Write;
    let mut child = crate::host::command("op")
        .args(with_account(&["item", "create", "--vault", &vault, "--format", "json", "-"]))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("op has no stdin")?
        .write_all(backup_key_template(&title, &identity, &recipient).as_bytes())
        .map_err(|e| e.to_string())?;
    let done = child.wait_with_output().map_err(|e| e.to_string())?;
    if !done.status.success() {
        return Err(String::from_utf8_lossy(&done.stderr).trim().to_string());
    }
    Ok(BackupKey { item: format!("op://{vault}/{title}"), public_key: recipient })
}

#[cfg(test)]
mod tests {

    // El contrato de `rotate-secrets`: CLAVE=valor por línea, sin lo que es
    // sólo del build, y un valor de dos líneas se rechaza nombrando la clave.
    #[test]
    fn el_comando_del_servidor_recibe_clave_valor_por_linea() {
        let entries = vec![
            ("DATABASE_URL".to_string(), "postgres://u:p@h/db?a=1".to_string()),
            ("NEXT_PUBLIC_APP_URL".to_string(), "https://x".to_string()),
            ("MAIL_PORT".to_string(), "587".to_string()),
        ];
        let build: std::collections::HashSet<String> = ["NEXT_PUBLIC_APP_URL".to_string()].into();
        assert_eq!(
            rotate_command_input(&entries, &build).unwrap(),
            "DATABASE_URL=postgres://u:p@h/db?a=1\nMAIL_PORT=587\n"
        );
        let malo = vec![("CERT".to_string(), "linea1\nlinea2".to_string())];
        let err = rotate_command_input(&malo, &Default::default()).unwrap_err();
        assert!(err.contains("CERT") && !err.contains("linea1"), "{err}");
    }

    #[test]
    fn lee_lo_que_dice_rotate_secrets() {
        let out = "creado rrhh_dev_MAIL_HOST_714685581a79d177\nactualizando web-rrhh-dev_app: MAIL_HOST\n--- dev ---\n  DATABASE_URL -> rrhh_dev_DATABASE_URL_ef0e0191d6a566b3\n  MAIL_HOST -> rrhh_dev_MAIL_HOST_714685581a79d177\nalgo raro -> con espacios\n";
        let r = parse_rotate_command_output(out);
        assert!(r.updated);
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0], RotatedSecret { name: "DATABASE_URL".into(), secret: "rrhh_dev_DATABASE_URL_ef0e0191d6a566b3".into(), changed: false });
        assert!(r.items[1].changed);
        let quieto = parse_rotate_command_output("sin cambios: el servicio ya apunta a estos valores\n--- dev ---\n  MAIL_HOST -> rrhh_dev_MAIL_HOST_714685581a79d177\n");
        assert!(!quieto.updated && !quieto.items[0].changed);
    }
    use super::*;

    /// La llave tiene el formato de age: la privada en mayúsculas con su
    /// prefijo, la pública `age1` y 58 caracteres, y cada vez una distinta. La
    /// compatibilidad real con age se comprobó contra la librería de Go
    /// (`filippo.io/age`) al escribirlo, con `CAC_AGE_CROSSCHECK`.
    /// Mutantes: la privada en minúsculas (age no la lee); la misma llave dos
    /// veces.
    #[test]
    fn a_backup_key_has_the_age_format() {
        let (id, rc) = new_age_keypair();
        assert!(id.starts_with("AGE-SECRET-KEY-1") && id == id.to_uppercase(), "{id}");
        assert!(rc.starts_with("age1") && rc.len() == 62 && rc == rc.to_lowercase(), "{rc}");
        let (id2, rc2) = new_age_keypair();
        assert!(id != id2 && rc != rc2);
        if let Ok(path) = std::env::var("CAC_AGE_CROSSCHECK") {
            std::fs::write(path, format!("{id}\n{rc}\n")).unwrap();
        }
    }

    /// En 1Password la privada va en un campo oculto y la pública a la vista.
    /// Mutante: la privada como texto visible.
    #[test]
    fn the_private_key_is_concealed_in_1password() {
        let t: serde_json::Value = serde_json::from_str(&backup_key_template("cac backups", "AGE-SECRET-KEY-1X", "age1y")).unwrap();
        let fields = t["fields"].as_array().unwrap();
        let private = fields.iter().find(|f| f["value"] == "AGE-SECRET-KEY-1X").unwrap();
        assert_eq!(private["type"], "CONCEALED");
        let public = fields.iter().find(|f| f["value"] == "age1y").unwrap();
        assert_eq!(public["type"], "STRING");
    }

    fn entries() -> Vec<(String, String)> {
        vec![
            ("DATABASE_URL".into(), "postgres://u:p4ss'word@db/x".into()),
            ("AUTH_SECRET".into(), "s3cr3t-valor-largo".into()),
        ]
    }

    // Cada valor sale una sola vez —en su asignación— y nunca en un echo ni
    // como argumento de un comando.
    #[test]
    fn each_value_appears_once_and_only_in_its_assignment() {
        let s = rotation_script("beta-api-prod_app", &entries()).unwrap();
        for (_, v) in entries() {
            let quoted = sh_quote(&v);
            assert_eq!(s.matches(&quoted).count(), 1, "{v} aparece más de una vez");
            let line = s.lines().find(|l| l.contains(&quoted)).unwrap();
            assert!(line.starts_with("V='"), "el valor aparece fuera de su asignación: {line}");
        }
        assert!(s.matches("unset V").count() == 2);
        assert!(!s.contains("echo \"$V\"") && !s.contains("echo $V"));
        // Lo que se imprime son nombres.
        for line in s.lines().filter(|l| l.trim_start().starts_with("echo ")) {
            assert!(!line.contains("$V"), "se imprime un valor: {line}");
        }
    }

    // El valor llega a docker por stdin, nunca en la línea de comandos.
    #[test]
    fn values_reach_docker_through_stdin() {
        let s = rotation_script("svc", &entries()).unwrap();
        assert!(s.contains(r#"printf '%s' "$V" | docker secret create"#));
        assert!(s.contains(r#""$N" - >/dev/null"#));
    }

    #[test]
    fn names_and_services_are_checked() {
        assert!(rotation_script("svc; rm -rf /", &entries()).is_err());
        assert!(rotation_script("svc", &[("database_url".into(), "x".into())]).is_err());
        assert!(rotation_script("svc", &[("A".into(), "x".into()), ("A".into(), "y".into())]).is_err());
        assert!(rotation_script("svc", &[]).is_err());
        assert!(rotation_script("svc", &[("A".repeat(41), "x".into())]).is_err());
        assert!(rotation_script("svc", &[("A".repeat(40), "x".into())]).is_ok());
    }

    // De la salida sólo salen las líneas con forma de nombre: si el servidor
    // imprimiera otra cosa, no llega a la pantalla.
    #[test]
    fn only_name_lines_come_back() {
        let r = parse_rotation_output(
            "changed DATABASE_URL cac_DATABASE_URL_0123456789abcdef\nsame AUTH_SECRET cac_AUTH_SECRET_fedcba9876543210\nalgo raro con un valor\nupdated\nchanged lower cac_x\n",
        );
        assert_eq!(
            r,
            RotationResult {
                items: vec![
                    RotatedSecret { name: "DATABASE_URL".into(), secret: "cac_DATABASE_URL_0123456789abcdef".into(), changed: true },
                    RotatedSecret { name: "AUTH_SECRET".into(), secret: "cac_AUTH_SECRET_fedcba9876543210".into(), changed: false },
                ],
                updated: true,
            }
        );
    }

    // De un ítem salen etiquetas y referencias; los valores, no.
    #[test]
    fn an_item_gives_labels_not_values() {
        let f = item_fields(
            r#"{"fields":[
                {"label":"DATABASE_URL","value":"postgres://secreto","reference":"op://dwit/Web RRHH/DATABASE_URL"},
                {"label":"notesPlain","purpose":"NOTES","value":"nota","reference":"op://dwit/Web RRHH/notesPlain"},
                {"label":"sin ref","value":"x"}]}"#,
        )
        .unwrap();
        assert_eq!(f, vec![ItemField { label: "DATABASE_URL".into(), op_ref: "op://dwit/Web RRHH/DATABASE_URL".into() }]);
        assert!(!serde_json::to_string(&f).unwrap().contains("secreto"));
    }

    // El guion de verdad, contra un `docker` falso: el servicio queda con los
    // secrets nuevos, lo de antes se conserva y la salida sólo trae nombres.
    #[cfg(unix)]
    #[test]
    fn the_script_runs_against_a_fake_docker() {
        use std::os::unix::fs::PermissionsExt;
        if crate::host::command("python3").arg("-V").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("cac-secrets-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        // Un docker que apunta lo que le piden y lo que le llega por stdin, y
        // que lista los secrets de cac como lo haría el de verdad: uno viejo,
        // el que tiene puesto el servicio (la versión anterior de cac) y los
        // que se acaban de crear.
        let log = dir.join("docker.log");
        let prev = "cac_DATABASE_URL_1111111111111111";
        std::fs::write(
            dir.join("bin/docker"),
            format!(
                "#!/bin/bash\necho \"$*\" >> {log}\ncase \"$1 $2\" in\n  'service inspect') if [ \"$3\" = --format ] || [ \"$4\" = --format ]; then echo 'DATABASE_URL {prev}'; fi ;;\n  'secret inspect') exit 1 ;;\n  'secret create') cat >> {log}.stdin; echo \"${{@: -2:1}}\" >> {log}.created ;;\n  'secret ls') echo cac_VIEJO_0000000000000000; echo {prev}; cat {log}.created 2>/dev/null ;;\nesac\nexit 0\n",
                log = log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(dir.join("bin/docker"), std::fs::Permissions::from_mode(0o755)).unwrap();

        let script = rotation_script("web-rrhh-prod_app", &[("DATABASE_URL".into(), "postgres://s3cr3t".into())]).unwrap();
        let out = crate::host::command("bash")
            .arg("-s")
            .env("PATH", format!("{}:{}", dir.join("bin").display(), std::env::var("PATH").unwrap()))
            .env("HOME", &dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                use std::io::Write;
                c.stdin.take().unwrap().write_all(script.as_bytes())?;
                c.wait_with_output()
            })
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(!stdout.contains("s3cr3t"), "la salida trae el valor: {stdout}");
        let r = parse_rotation_output(&stdout);
        assert!(r.updated && r.items.len() == 1 && r.items[0].changed);
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(!calls.contains("s3cr3t"), "el valor fue en la línea de comandos de docker");
        let new = &r.items[0].secret;
        assert!(calls.contains(&format!("--secret-rm {prev} --secret-add source={new},target=DATABASE_URL")));
        // Lo viejo de cac se borra; lo de justo antes (para un rollback de
        // Swarm) y lo nuevo, no.
        assert!(calls.contains("secret rm cac_VIEJO_0000000000000000"));
        assert!(!calls.contains(&format!("secret rm {prev}")), "se borró la versión anterior");
        assert!(!calls.contains(&format!("secret rm {new}")), "se borró la versión nueva");
        assert_eq!(std::fs::read_to_string(format!("{}.stdin", log.display())).unwrap(), "postgres://s3cr3t");
        // La clave del HMAC queda sólo para el dueño.
        let mode = std::fs::metadata(dir.join(".cac/secret-version.key")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_dir_all(dir);
    }

    // Un secret sólo del build se crea con sus etiquetas (el agente lo busca
    // por ellas) pero no se cuelga del servicio, y se guarda de la poda; uno de
    // los dos usos va como siempre. Mutantes: colgarlo del servicio; no
    // guardarlo de la poda; sin la etiqueta `cac.key`.
    #[test]
    fn a_build_only_secret_is_kept_but_not_attached() {
        let only: std::collections::HashSet<String> = ["NEXT_PUBLIC_STRIPE_KEY".to_string()].into();
        let s = rotation_script_with(
            "boat_app",
            &[
                ("DATABASE_URL".into(), "postgres://x".into()),
                ("NEXT_PUBLIC_STRIPE_KEY".into(), "pk_live_x".into()),
            ],
            &only,
        )
        .unwrap();
        assert!(!s.contains("target=NEXT_PUBLIC_STRIPE_KEY"), "se colgó del servicio:\n{s}");
        assert!(s.contains("target=DATABASE_URL"));
        assert!(s.contains(r#"--label "cac.key=NEXT_PUBLIC_STRIPE_KEY" --label "cac.use=build""#));
        let build = s.split("N=\"cac_NEXT_PUBLIC_STRIPE_KEY_").nth(1).unwrap();
        assert!(build.split("N=\"cac_").next().unwrap().contains(r#"KEEP+=("$N")"#), "la poda se lo llevaría");
        assert_eq!(s.matches(&sh_quote("pk_live_x")).count(), 1);
    }

    // Capturar lo que corre: el guion sólo lee; se quedan las variables que
    // pueden ser un secret; y el ítem lleva cada valor oculto y con la
    // variable como nombre. Mutantes: un guion que cambie el servicio; no
    // filtrar los nombres; campos visibles en vez de ocultos.
    #[test]
    fn capturing_reads_the_service_and_hides_each_value() {
        let script = env_capture_script("boat-dev_app").unwrap();
        assert!(script.contains("docker service inspect") && !script.contains("update") && !script.contains("secret create"));
        assert!(script.contains("'{{json .Spec.TaskTemplate.ContainerSpec.Env}}'"), "{script}");
        assert!(env_capture_script("x; rm -rf /").is_err());

        let env = parse_service_env(r#"["DATABASE_URL=sqlserver://a=b","lower=x","PORT=3000","PORT=4000","SIN_VALOR"]"#).unwrap();
        assert_eq!(env, vec![("DATABASE_URL".into(), "sqlserver://a=b".into()), ("PORT".into(), "3000".into())]);
        assert!(parse_service_env("null").unwrap().is_empty());

        let t: serde_json::Value = serde_json::from_str(&capture_template("web-boaty dev", &env)).unwrap();
        assert_eq!(t["title"], "web-boaty dev");
        assert_eq!(t["fields"][0]["label"], "DATABASE_URL");
        assert_eq!(t["fields"][0]["type"], "CONCEALED");
        assert_eq!(t["fields"][0]["value"], "sqlserver://a=b");
    }

    // Leer un ítem entero casa cada referencia por la suya exacta; la de otro
    // ítem o la que no está no se inventa. Mutantes: casar por etiqueta (dos
    // `password` de secciones distintas se pisarían); aceptar cualquier
    // referencia.
    #[test]
    fn an_item_read_once_resolves_its_exact_references() {
        let json = r#"{"fields":[
            {"label":"password","reference":"op://dwit/web/db/password","value":"db-pass"},
            {"label":"password","reference":"op://dwit/web/mail/password","value":"mail-pass"},
            {"label":"DATABASE_URL","reference":"op://dwit/web/DATABASE_URL","value":"sqlserver://x"}]}"#;
        let got = values_from_item(json, &["op://dwit/web/mail/password", "op://dwit/web/DATABASE_URL", "op://dwit/web/NADA"]);
        assert_eq!(got.len(), 2);
        assert_eq!(got["op://dwit/web/mail/password"], "mail-pass");
        assert_eq!(got["op://dwit/web/DATABASE_URL"], "sqlserver://x");
        assert_eq!(item_of("op://dwit/web staging/sec/F").as_deref(), Some("op://dwit/web staging"));
        assert_eq!(item_of("op://dwit/web"), None);
    }
}
