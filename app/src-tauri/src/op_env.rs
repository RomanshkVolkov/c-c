//! Variables de un Environment de 1Password, leídas del `.env` que 1Password
//! monta en esta máquina.
//!
//! Un Environment no es un ítem: sus variables no tienen dirección `op://` y
//! el `op` de la línea de órdenes no las lee. Lo que ofrece 1Password es
//! montarlo como un fichero `.env` (por dentro, una tubería que la app de
//! 1Password rellena al leerla, con su aprobación). cac lo lee de ahí al
//! rotar los secrets de un servicio, igual que lee un `op://` con `op`: en la
//! máquina de quien rota, sin que el valor pase por el backend.
//!
//! La referencia es `op-env://<Environment>/<VARIABLE>` y **dónde** está
//! montado cada Environment lo dice esta máquina (la app lo guarda en local),
//! porque es distinto en cada una.

use std::collections::HashMap;

/// `op-env://RRHH prod/DATABASE_URL` → `("RRHH prod", "DATABASE_URL")`.
pub fn env_ref(r: &str) -> Option<(&str, &str)> {
    let rest = r.strip_prefix("op-env://")?;
    let (env, var) = rest.split_once('/')?;
    (!env.is_empty() && !var.is_empty() && !var.contains('/')).then_some((env, var))
}

/// Un `.env`: `CLAVE=valor` por línea, con `export ` delante o sin él,
/// valores entre comillas simples o dobles, y comentarios y líneas vacías que
/// no cuentan. Lo justo de lo que escribe 1Password, que es lo único que lee.
pub fn parse_dotenv(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim();
        let value = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')))
        {
            let inner = &value[1..value.len() - 1];
            // Dentro de comillas dobles, los escapes de siempre; en simples,
            // tal cual.
            if value.starts_with('"') {
                inner.replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\")
            } else {
                inner.to_string()
            }
        } else {
            value.to_string()
        };
        out.insert(key.to_string(), value);
    }
    out
}

/// `~/x` → la carpeta de la persona: así es como se escribe una ruta a mano,
/// y el sistema de ficheros no la entiende.
pub fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => {
            let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
            if home.is_empty() {
                path.to_string()
            } else {
                format!("{}/{rest}", home.trim_end_matches('/'))
            }
        }
        None => path.to_string(),
    }
}

fn read_env(path: &str) -> Result<HashMap<String, String>, String> {
    let path = expand_home(path.trim());
    let text = std::fs::read_to_string(&path).map_err(|e| format!("no se pudo leer {path}: {e}"))?;
    Ok(parse_dotenv(&text))
}

/// Los valores de las referencias `op-env://`, por su referencia exacta.
/// `files`: de cada Environment, dónde está montado en esta máquina. Cada
/// fichero se lee una vez aunque lo usen muchas variables.
pub fn resolve(refs: &[&str], files: &HashMap<String, String>) -> Result<HashMap<String, String>, String> {
    let mut read: HashMap<&str, HashMap<String, String>> = HashMap::new();
    let mut out = HashMap::new();
    for r in refs {
        let Some((env, var)) = env_ref(r) else { continue };
        let path = files
            .get(env)
            .ok_or_else(|| format!("el Environment «{env}» no está montado en esta máquina"))?;
        if !read.contains_key(env) {
            read.insert(env, read_env(path)?);
        }
        let value = read[env]
            .get(var)
            .ok_or_else(|| format!("«{var}» no está en el Environment «{env}»"))?;
        out.insert((*r).to_string(), value.clone());
    }
    Ok(out)
}

/// Los nombres de las variables del `.env` montado, ordenados. Para importar
/// un Environment a los secrets de un servicio: sólo los nombres, los valores
/// no salen de aquí.
#[tauri::command]
pub fn env_file_names(path: String) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = read_env(&path)?.into_keys().collect();
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_ruta_con_virgulilla_es_la_carpeta_de_la_persona() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_home("~/x/prod.env"), format!("{}/x/prod.env", home.trim_end_matches('/')));
        assert_eq!(expand_home("/abs/prod.env"), "/abs/prod.env");
    }

    #[test]
    fn la_referencia_dice_environment_y_variable() {
        assert_eq!(env_ref("op-env://RRHH prod/DATABASE_URL"), Some(("RRHH prod", "DATABASE_URL")));
        assert_eq!(env_ref("op-env://RRHH prod/"), None);
        assert_eq!(env_ref("op-env:///X"), None);
        assert_eq!(env_ref("op-env://a/b/c"), None);
        assert_eq!(env_ref("op://v/i/f"), None);
    }

    #[test]
    fn lee_un_env_como_lo_escribe_1password() {
        let env = parse_dotenv(
            "# comentario\n# TOKEN=una variable comentada no cuenta\n\nDATABASE_URL=\"postgres://u:p@h/db?x=1\"\nexport MAIL_PORT=587\nNAME='a b'\nMULTI=\"uno\\ndos\"\nVACIA=\nmalformada\n",
        );
        assert_eq!(env["DATABASE_URL"], "postgres://u:p@h/db?x=1");
        assert_eq!(env["MAIL_PORT"], "587");
        assert_eq!(env["NAME"], "a b");
        assert_eq!(env["MULTI"], "uno\ndos");
        assert_eq!(env["VACIA"], "");
        assert!(!env.contains_key("malformada"));
        assert!(!env.contains_key("# TOKEN") && !env.contains_key("TOKEN"));
        assert_eq!(env.len(), 5);
    }

    #[test]
    fn resuelve_cada_referencia_de_su_environment() {
        let dir = std::env::temp_dir().join(format!("cac-op-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let prod = dir.join("prod.env");
        std::fs::write(&prod, "DATABASE_URL=postgres://prod\nMAIL_PORT=587\n").unwrap();
        let files = HashMap::from([("RRHH prod".to_string(), prod.to_string_lossy().into_owned())]);

        let got = resolve(&["op-env://RRHH prod/DATABASE_URL", "op://v/i/f"], &files).unwrap();
        assert_eq!(got["op-env://RRHH prod/DATABASE_URL"], "postgres://prod");
        // Lo que no es op-env:// no lo toca: lo lee `op`.
        assert!(!got.contains_key("op://v/i/f"));

        let falta = resolve(&["op-env://RRHH prod/NO_ESTA"], &files).unwrap_err();
        assert!(falta.contains("NO_ESTA"), "{falta}");
        let sin_montar = resolve(&["op-env://RRHH dev/DATABASE_URL"], &files).unwrap_err();
        assert!(sin_montar.contains("no está montado"), "{sin_montar}");
        // Y un error no lleva valores dentro.
        assert!(!falta.contains("postgres://prod") && !sin_montar.contains("postgres://prod"));

        assert_eq!(env_file_names(prod.to_string_lossy().into_owned()).unwrap(), vec!["DATABASE_URL", "MAIL_PORT"]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
