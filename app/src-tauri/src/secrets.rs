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

/// Lee cada referencia en 1Password y la lleva al servicio. Devuelve nombres.
#[tauri::command]
pub fn rotate_service_secrets(target: SshTarget, service: String, refs: Vec<SecretRef>) -> Result<RotationResult, String> {
    let mut entries = Vec::with_capacity(refs.len());
    for r in &refs {
        if !r.op_ref.starts_with("op://") {
            return Err(format!("{}: `{}` is not op://", r.name, r.op_ref));
        }
        let value = crate::op_read(&r.op_ref).map_err(|e| format!("{}: {e}", r.name))?;
        entries.push((r.name.clone(), value));
    }
    let build_only: std::collections::HashSet<String> = refs
        .iter()
        .filter(|r| r.usage.as_deref() == Some("build"))
        .map(|r| r.name.clone())
        .collect();
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
pub fn check_op_refs(refs: Vec<String>) -> Vec<RefCheck> {
    refs.into_iter()
        .map(|r| match crate::op_read(&r) {
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
    let out = std::process::Command::new("op")
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
    let exists = std::process::Command::new("op")
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
    let mut child = std::process::Command::new("op")
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

#[cfg(test)]
mod tests {
    use super::*;

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
        if std::process::Command::new("python3").arg("-V").output().is_err() {
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
        let out = std::process::Command::new("bash")
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
}
