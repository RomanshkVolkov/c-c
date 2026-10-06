//! Instalar (o reinstalar) el agente `swarm-manage` en un servidor, con su
//! identidad.
//!
//! Hasta la versión 1 el agente no tenía auth: el puerto 9090 abierto al mundo
//! le daba a quien supiera la IP los logs de todos los servicios y el botón de
//! reiniciarlos. Desde la 2 el agente arranca con dos secrets —su token, para
//! hablarle al backend, y la llave de sesión, para verificar a la app— y sin
//! ellos no abre `/api/v1`.
//!
//! Los dos valores los acuña el backend (`POST /servers/{id}/agent-token`) y
//! esta máquina los lleva al servidor **por stdin**: el comando remoto es
//! `sh -s` y el guion entero, con los valores dentro, entra por la entrada
//! estándar. Ni en el argv local, ni en el remoto, ni en `docker service
//! inspect` (van como Docker secrets). Instalar y actualizar son lo mismo: una
//! identidad nueva cada vez, que tumba la anterior.

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{ssh_run_input, stage_public_key, SshOutput};

/// La versión del agente que esta app sabe hablar. La publica
/// `.github/workflows/swarm-manage.yml` desde `swarm-manage/VERSION`; que las
/// dos digan lo mismo lo fija `la_imagen_es_la_version_del_agente`.
pub(crate) const AGENT_IMAGE: &str = "ghcr.io/romanshkvolkov/c-c/swarm-manage:v5";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstall {
    pub host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub agent_port: u16,
    pub stack: Option<String>,
    /// La llave pública con la que fijar ssh (ver `list_agent_ssh_keys`).
    pub identity_key: Option<String>,
    pub server_id: String,
    pub backend_url: String,
    pub agent_token: String,
    pub session_key: String,
}

/// Nombre de Docker secret con versión. Los secrets de Docker son inmutables:
/// cambiar el valor es crear otro con otro nombre. Con el hash del valor en el
/// nombre, reinstalar con los mismos valores no crea nada.
fn secret_name(base: &str, value: &str) -> String {
    let h = Sha256::digest(value.as_bytes());
    format!("{base}_{}", &hex::encode(h)[..12])
}

/// Comillas simples para sh: lo único que no se puede meter entre ellas es
/// otra comilla simple, que se cierra, se escapa y se vuelve a abrir.
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'\''"#))
}

/// Lo que se interpola en el YAML y en el guion tiene que ser lo que parece.
/// Los valores secretos van además entre comillas de sh, pero el id y la URL
/// acaban en el compose, y ahí una comilla o un salto de línea cambian el
/// documento.
fn validate(i: &AgentInstall) -> Result<(), String> {
    let id_ok = !i.server_id.is_empty()
        && i.server_id.len() <= 64
        && i.server_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !id_ok {
        return Err("id de servidor inválido".into());
    }
    let url_ok = (i.backend_url.starts_with("https://") || i.backend_url.starts_with("http://"))
        && i.backend_url.len() <= 200
        && i.backend_url
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".:/-_".contains(c));
    if !url_ok {
        return Err("URL del backend inválida".into());
    }
    if !i.agent_token.starts_with("cac_agent_")
        || !i.agent_token[10..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("token de agente inválido".into());
    }
    if i.session_key.len() != 64 || !i.session_key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("llave de sesión inválida".into());
    }
    if let Some(stack) = &i.stack {
        if stack.is_empty()
            || !stack
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("nombre de stack inválido".into());
        }
    }
    Ok(())
}

/// El compose del agente. Sin valores secretos: sólo los nombres de los
/// secrets, que no revelan nada (llevan un hash del valor, no el valor).
fn compose(
    i: &AgentInstall,
    token_secret: &str,
    key_secret: &str,
    registry_secret: Option<&str>,
) -> String {
    // Las credenciales del registro son opcionales: sin ellas el agente sólo
    // puede bajar imágenes públicas, y un deploy de una privada lo dice al
    // fallar.
    let (reg_mount, reg_decl) = match registry_secret {
        Some(r) => (
            format!("\n      - source: {r}\n        target: cac_registry_auth"),
            format!("  {r}:\n    external: true\n"),
        ),
        None => (String::new(), String::new()),
    };
    format!(
        "version: '3.8'
services:
  swarm-manage:
    image: {AGENT_IMAGE}
    ports:
      - \"{port}:9090\"
    environment:
      CAC_URL: \"{url}\"
      CAC_SERVER_ID: \"{id}\"
    secrets:
      - source: {token_secret}
        target: cac_agent_token
      - source: {key_secret}
        target: cac_agent_session_key{reg_mount}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
secrets:
  {token_secret}:
    external: true
  {key_secret}:
    external: true
{reg_decl}",
        port = i.agent_port,
        url = i.backend_url,
        id = i.server_id,
    )
}

/// El guion que corre `sh -s` en el servidor. Entra por stdin.
///
/// `printf` es un builtin de sh, así que el valor que se le pasa no aparece
/// como argumento de ningún proceso: va de la memoria del shell al stdin de
/// `docker secret create`. Al final se podan las versiones viejas de los
/// secrets del agente; las que sigue usando alguna tarea se niegan a borrarse
/// y se quedan para la próxima vez.
pub(crate) fn install_script(
    i: &AgentInstall,
    registry_auth: Option<&str>,
) -> Result<String, String> {
    validate(i)?;
    let stack = i.stack.clone().unwrap_or_else(|| "cac".to_string());
    let token_secret = secret_name("cac_agent_token", &i.agent_token);
    let key_secret = secret_name("cac_agent_session_key", &i.session_key);
    let registry_secret = registry_auth.map(|r| secret_name("cac_registry_auth", r));
    let compose = compose(i, &token_secret, &key_secret, registry_secret.as_deref());
    let (reg_var, reg_create, reg_keep) = match (&registry_secret, registry_auth) {
        (Some(name), Some(value)) => (
            format!("REG={}\n", sh_quote(value)),
            format!("docker secret inspect {name} >/dev/null 2>&1 || printf '%s' \"$REG\" | docker secret create {name} - >/dev/null\n"),
            format!("|{name}"),
        ),
        _ => (String::new(), String::new(), String::new()),
    };
    Ok(format!(
        "set -eu
umask 077
TOKEN={token}
SKEY={skey}
{reg_var}docker secret inspect {token_secret} >/dev/null 2>&1 || printf '%s' \"$TOKEN\" | docker secret create {token_secret} - >/dev/null
docker secret inspect {key_secret} >/dev/null 2>&1 || printf '%s' \"$SKEY\" | docker secret create {key_secret} - >/dev/null
{reg_create}unset TOKEN SKEY REG
F=$(mktemp)
cat > \"$F\" <<'CAC_COMPOSE'
{compose}CAC_COMPOSE
docker stack deploy -c \"$F\" {stack}
rm -f \"$F\"
for s in $(docker secret ls --filter name=cac_agent_ --filter name=cac_registry_auth --format '{{{{.Name}}}}'); do
  case \"$s\" in
    {token_secret}|{key_secret}{reg_keep}) ;;
    *) docker secret rm \"$s\" >/dev/null 2>&1 || true ;;
  esac
done
echo \"agente {AGENT_IMAGE} instalado en el stack {stack}\"
",
        token = sh_quote(&i.agent_token),
        skey = sh_quote(&i.session_key),
    ))
}

/// Las credenciales del registro como las lee el agente
/// (`config.RegistryAuth`). ghcr acepta cualquier usuario con un token.
fn registry_auth_json(token: &str) -> String {
    serde_json::json!({ "username": "x-access-token", "password": token }).to_string()
}

/// Instala o reinstala el agente. La identidad la acuña el backend justo
/// antes; aquí sólo se lleva.
#[tauri::command]
pub fn install_swarm_manage_agent(install: AgentInstall) -> Result<SshOutput, String> {
    // El token de GitHub de este servidor, si se guardó (la pantalla de
    // secretos del stack lo usa ya): con él el agente puede bajar las imágenes
    // privadas de ghcr. Sin él, sólo públicas.
    let registry = crate::keychain_get(&install.server_id)
        .ok()
        .map(|token| registry_auth_json(&token));
    let script = install_script(&install, registry.as_deref())?;
    let staged = match install
        .identity_key
        .as_deref()
        .filter(|k| !k.trim().is_empty())
    {
        Some(k) => Some(stage_public_key(k)?),
        None => None,
    };
    let identity = staged
        .as_ref()
        .map(|s| s.path.to_string_lossy().into_owned());
    ssh_run_input(
        &install.host,
        install.ssh_port,
        &install.ssh_user,
        "sh -s",
        identity.as_deref(),
        Some(&script),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_base_args;

    fn install() -> AgentInstall {
        AgentInstall {
            host: "10.0.0.1".into(),
            ssh_port: 22,
            ssh_user: "root".into(),
            agent_port: 9090,
            stack: None,
            identity_key: None,
            server_id: "7a1c2d3e-0000-4000-8000-000000000001".into(),
            backend_url: "https://cac.guz-studio.dev".into(),
            agent_token: "cac_agent_SECRETOtokenABC_-123".into(),
            session_key: "ab".repeat(32),
        }
    }

    /// Ni el token ni la llave aparecen en los argumentos de ssh: van por
    /// stdin. Un argumento se ve con `ps` en las dos máquinas.
    #[test]
    fn los_secretos_no_viajan_como_argumentos() {
        let i = install();
        let args = ssh_base_args(&i.host, i.ssh_port, &i.ssh_user, "sh -s", None);
        let todo = args.join(" ");
        assert!(
            !todo.contains(&i.agent_token),
            "el token está en el argv de ssh: {todo}"
        );
        assert!(
            !todo.contains(&i.session_key),
            "la llave está en el argv de ssh: {todo}"
        );
        assert_eq!(args.last().map(String::as_str), Some("sh -s"));
    }

    /// El compose no lleva valores, sólo nombres versionados; y los monta en
    /// las rutas fijas que lee el agente.
    #[test]
    fn el_compose_nombra_los_secretos_sin_llevarlos() {
        let i = install();
        let script = install_script(&i, None).unwrap();
        let inicio = script.find("<<'CAC_COMPOSE'").unwrap();
        let compose = &script[inicio..];
        assert!(!compose.contains(&i.agent_token));
        assert!(!compose.contains(&i.session_key));
        assert!(compose.contains("target: cac_agent_token"));
        assert!(compose.contains("target: cac_agent_session_key"));
        assert!(compose.contains(&format!("CAC_SERVER_ID: \"{}\"", i.server_id)));
        assert!(compose.contains(AGENT_IMAGE));
        // Y el secret se crea desde stdin, con printf (builtin), no como argumento.
        assert!(script.contains("printf '%s' \"$TOKEN\" | docker secret create"));
        // Cada valor sale **una vez** en todo el guion: en su asignación a la
        // variable. Cualquier otra aparición es el valor usado a pelo, como
        // argumento de algo, y eso lo ve `ps` en el servidor.
        assert_eq!(
            script.matches(&i.agent_token).count(),
            1,
            "el token aparece fuera de su asignación"
        );
        assert_eq!(
            script.matches(&i.session_key).count(),
            1,
            "la llave aparece fuera de su asignación"
        );
    }

    /// Con token de GitHub, el agente recibe credenciales del registro: como
    /// secret, montadas donde las lee, y el valor una sola vez en el guion.
    /// Sin token, ni rastro.
    #[test]
    fn las_credenciales_del_registro_van_como_secreto() {
        let i = install();
        let reg = registry_auth_json("ghp_SECRETO123");
        let script = install_script(&i, Some(&reg)).unwrap();
        assert!(script.contains("target: cac_registry_auth"));
        assert_eq!(
            script.matches("ghp_SECRETO123").count(),
            1,
            "el token aparece fuera de su asignación"
        );
        assert!(script.contains("printf '%s' \"$REG\" | docker secret create cac_registry_auth_"));

        let sin = install_script(&i, None).unwrap();
        assert!(
            !sin.contains("cac_registry_auth_"),
            "sin token no debe haber secret del registro"
        );
        assert!(!sin.contains("REG="));
    }

    /// El mismo valor da el mismo nombre (reinstalar no crea nada), y uno
    /// distinto, otro (los secrets de Docker no se pueden cambiar).
    #[test]
    fn el_nombre_del_secreto_sigue_al_valor() {
        assert_eq!(secret_name("x", "a"), secret_name("x", "a"));
        assert_ne!(secret_name("x", "a"), secret_name("x", "b"));
    }

    /// Una comilla en un valor no rompe el guion.
    #[test]
    fn las_comillas_de_sh_aguantan_una_comilla() {
        assert_eq!(sh_quote("a'b"), r#"'a'\''b'"#);
    }

    /// Lo que va al YAML tiene que ser lo que parece.
    #[test]
    fn se_rechaza_lo_que_romperia_el_compose() {
        let mut i = install();
        i.server_id = "abc\n  privileged: true".into();
        assert!(install_script(&i, None).is_err());

        let mut i = install();
        i.backend_url = "https://cac.guz-studio.dev\"\n  x: y".into();
        assert!(install_script(&i, None).is_err());

        let mut i = install();
        i.agent_token = "cac_agent_abc'; rm -rf /".into();
        assert!(install_script(&i, None).is_err());

        let mut i = install();
        i.session_key = "zz".repeat(32);
        assert!(install_script(&i, None).is_err());

        let mut i = install();
        i.stack = Some("cac; reboot".into());
        assert!(install_script(&i, None).is_err());

        assert!(install_script(&install(), None).is_ok());
    }

    /// El guion es sh válido. Se corre en el servidor por stdin, así que un
    /// error de sintaxis —una comilla mal cerrada al escapar un valor— sólo se
    /// vería allí, a medias, con un secret creado y el agente sin desplegar.
    #[test]
    fn el_guion_es_sh_valido() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut i = install();
        i.agent_token = "cac_agent_con-guion_y_barra".into();
        for reg in [None, Some(registry_auth_json("ghp_con'comilla"))] {
            let script = install_script(&i, reg.as_deref()).unwrap();
            let mut sh = Command::new("sh")
                .arg("-n")
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("sh");
            sh.stdin
                .take()
                .unwrap()
                .write_all(script.as_bytes())
                .unwrap();
            let out = sh.wait_with_output().unwrap();
            assert!(
                out.status.success(),
                "sh -n: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    /// La imagen que instala la app es la versión que publica el workflow.
    ///
    /// `latest` a secas dejaba que una app nueva instalara un agente viejo (o
    /// al revés) sin que nada lo dijera; con auth de por medio eso es un
    /// agente que no abre o una app que no entra.
    #[test]
    fn la_imagen_es_la_version_del_agente() {
        let version = include_str!("../../../swarm-manage/VERSION").trim();
        assert!(
            AGENT_IMAGE.ends_with(&format!(":v{version}")),
            "AGENT_IMAGE ({AGENT_IMAGE}) no es la versión de swarm-manage/VERSION (v{version})"
        );
    }
}
