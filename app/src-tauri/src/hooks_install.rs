//! Los hooks de cac para Claude Code, instalados globales desde el MCP
//! (`install_hooks`, command-and-control-317).
//!
//! Hasta el 5-nov-2026 vivían sólo en el repo de cac (`.claude/hooks/`), así
//! que en cualquier otro repo —crossfire, TDS— no corría ninguno: ni el mapa
//! al arrancar, ni lo que ya mordió, ni el «dónde quedó» antes de parar. Y
//! jose recordaba a mano «usa cac» varias veces por sesión.
//!
//! Los scripts van dentro del binario (los mismos ficheros del repo, con
//! `include_str!`), se copian a `$CLAUDE_CONFIG_DIR/hooks/cac/` y se enlazan en
//! el `settings.json` de la persona **sin tocar** lo que ya tenga: cada
//! entrada nuestra se reconoce por su ruta (`hooks/cac/<script>`), se quita y
//! se vuelve a poner, así que instalar dos veces no duplica nada. En un repo
//! que trae sus propios hooks de cac, la copia global calla (`shadowed` en
//! `cac_hooks.py`).

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// Los ficheros, tal como están en el repo.
pub const HOOK_FILES: &[(&str, &str)] = &[
    ("cac_hooks.py", include_str!("../../../.claude/hooks/cac_hooks.py")),
    ("cac-session", include_str!("../../../.claude/hooks/cac-session")),
    ("cac-prompt", include_str!("../../../.claude/hooks/cac-prompt")),
    ("cac-edit", include_str!("../../../.claude/hooks/cac-edit")),
    ("cac-wrote", include_str!("../../../.claude/hooks/cac-wrote")),
    ("cac-handoff", include_str!("../../../.claude/hooks/cac-handoff")),
];

/// Qué se engancha a qué: (evento, matcher, script, timeout en segundos).
/// `SessionStart` también con `compact`: tras compactar, el mapa vuelve.
const ENTRIES: &[(&str, Option<&str>, &str, u32)] = &[
    ("SessionStart", Some("startup"), "cac-session", 15),
    ("SessionStart", Some("resume"), "cac-session", 15),
    ("SessionStart", Some("clear"), "cac-session", 15),
    ("SessionStart", Some("compact"), "cac-session", 15),
    ("UserPromptSubmit", None, "cac-prompt", 5),
    ("PreToolUse", Some("Edit|Write|MultiEdit"), "cac-edit", 5),
    // Con el `.*`: un `mcp__cac` a secas se compara como texto exacto y no
    // casa con ninguna herramienta.
    ("PostToolUse", Some("mcp__cac__.*"), "cac-wrote", 5),
    ("Stop", None, "cac-handoff", 20),
];

/// La carpeta, dentro de la de Claude Code, donde van los scripts.
pub const DIR_NAME: &str = "cac";

#[derive(Debug, PartialEq)]
pub enum HooksState {
    Missing,
    Outdated,
    Current,
}

/// La versión de una copia, de su marca `# cac-hooks vN` en `cac_hooks.py`.
pub fn version(text: &str) -> Option<u32> {
    let tail = text.split("# cac-hooks v").nth(1)?;
    tail.split_whitespace().next()?.parse().ok()
}

fn shipped_version() -> Option<u32> {
    version(HOOK_FILES[0].1)
}

pub fn hooks_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("hooks").join(DIR_NAME)
}

/// Si están, y si son las de esta app. Sin las entradas en `settings.json`
/// cuentan como no instalados: los ficheros solos no corren.
pub fn state(config_dir: &Path) -> HooksState {
    let Ok(text) = std::fs::read_to_string(hooks_dir(config_dir).join("cac_hooks.py")) else {
        return HooksState::Missing;
    };
    let settings = std::fs::read_to_string(config_dir.join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    if ENTRIES.iter().any(|(event, _, script, _)| !has_handler(&settings, event, script)) {
        return HooksState::Missing;
    }
    match (version(&text), shipped_version()) {
        (Some(have), Some(ship)) if have >= ship => HooksState::Current,
        _ => HooksState::Outdated,
    }
}

/// El nombre del intérprete: en Windows no hay `python3`.
fn python() -> &'static str {
    if cfg!(windows) {
        "python"
    } else {
        "python3"
    }
}

fn command_for(dir: &Path, script: &str) -> String {
    format!("{} \"{}\"", python(), dir.join(script).display())
}

/// Si un comando es nuestro, y de qué script: termina en `hooks/cac/<script>`
/// (con comillas o sin ellas, con `/` o con `\`).
fn ours(command: &str, script: &str) -> bool {
    let c = command.trim().trim_end_matches('"').replace('\\', "/");
    c.ends_with(&format!("hooks/{DIR_NAME}/{script}"))
}

fn has_handler(settings: &Value, event: &str, script: &str) -> bool {
    settings["hooks"][event].as_array().is_some_and(|entries| {
        entries.iter().any(|e| {
            e["hooks"].as_array().is_some_and(|hs| {
                hs.iter().any(|h| h["command"].as_str().is_some_and(|c| ours(c, script)))
            })
        })
    })
}

/// El `settings.json` con nuestras entradas puestas y lo demás intacto.
pub fn merge_settings(mut settings: Value, dir: &Path) -> Result<Value, String> {
    if settings.is_null() {
        settings = json!({});
    }
    let root = settings.as_object_mut().ok_or("settings.json is not a JSON object")?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("`hooks` in settings.json is not an object")?;

    // Primero se quita todo lo nuestro (una ruta vieja, un matcher que cambió)…
    for (event, _, script, _) in ENTRIES {
        if let Some(entries) = hooks.get_mut(*event).and_then(|v| v.as_array_mut()) {
            for e in entries.iter_mut() {
                if let Some(hs) = e.get_mut("hooks").and_then(|v| v.as_array_mut()) {
                    hs.retain(|h| !h["command"].as_str().is_some_and(|c| ours(c, script)));
                }
            }
            // …y una entrada que se queda sin manejadores, también: era nuestra.
            entries.retain(|e| e["hooks"].as_array().map_or(true, |hs| !hs.is_empty()));
        }
    }
    // …y después se pone, una vez.
    for (event, matcher, script, timeout) in ENTRIES {
        let entries = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
        let entries = entries
            .as_array_mut()
            .ok_or_else(|| format!("`hooks.{event}` in settings.json is not a list"))?;
        let mut entry = Map::new();
        if let Some(m) = matcher {
            entry.insert("matcher".into(), json!(m));
        }
        entry.insert(
            "hooks".into(),
            json!([{ "type": "command", "command": command_for(dir, script), "timeout": timeout }]),
        );
        entries.push(Value::Object(entry));
    }
    Ok(settings)
}

/// Escribe un fichero entero o nada: a uno de al lado y se mueve encima.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("cac-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not write {}: {e}", path.display())
    })
}

/// Instala (o pone al día) los hooks en `config_dir`, la carpeta de Claude Code.
pub fn install(config_dir: &Path, dry_run: bool) -> Result<Value, String> {
    let dir = hooks_dir(config_dir);
    let settings_path = config_dir.join("settings.json");
    let before = match std::fs::read_to_string(&settings_path) {
        Ok(s) if s.trim().is_empty() => Value::Null,
        // Un settings.json que no se entiende no se pisa: se dice.
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| format!("{} is not valid JSON ({e}); fix it before installing the hooks", settings_path.display()))?,
        Err(_) => Value::Null,
    };
    let previous = std::fs::read_to_string(dir.join("cac_hooks.py")).ok().as_deref().and_then(version);
    let merged = merge_settings(before, &dir)?;
    let result = json!({
        "dir": dir.display().to_string(),
        "settings": settings_path.display().to_string(),
        "version": shipped_version(),
        "previousVersion": previous,
        "hooks": ENTRIES.iter().map(|(e, m, s, _)| match m {
            Some(m) => format!("{e} ({m}) → {s}"),
            None => format!("{e} → {s}"),
        }).collect::<Vec<_>>(),
        "note": "They take effect in the next Claude Code session. In a repository that brings its own cac hooks (cac itself), the global ones stay quiet.",
    });
    if dry_run {
        return Ok(json!({ "wouldWrite": result, "dryRun": true }));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    for (name, text) in HOOK_FILES {
        let path = dir.join(name);
        write_atomic(&path, text)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }
    }
    let text = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())? + "\n";
    write_atomic(&settings_path, &text)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cac-hooks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn handlers(settings: &Value, event: &str) -> Vec<String> {
        settings["hooks"][event]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|e| e["hooks"].as_array().unwrap().iter().map(|h| h["command"].as_str().unwrap().to_string()))
            .collect()
    }

    /// Rotura que detecta: pisar los hooks que la persona ya tiene, perder el
    /// orden de sus claves, duplicar los nuestros al instalar otra vez, o
    /// dejar la ruta vieja cuando cambia la carpeta.
    #[test]
    fn install_hooks_merges_settings_and_never_duplicates() {
        let mine = json!({
            "model": "opus",
            "hooks": {
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/.claude/hooks/relevo" }] }],
                "SessionStart": [{ "matcher": "startup", "hooks": [{ "type": "command", "command": "~/.claude/hooks/cbm" }] }]
            },
            "enabledPlugins": {}
        });
        let once = merge_settings(mine.clone(), Path::new("/c/hooks/cac")).unwrap();
        let twice = merge_settings(once.clone(), Path::new("/c/hooks/cac")).unwrap();
        assert_eq!(once, twice, "instalar dos veces cambia algo");
        let keys: Vec<&String> = once.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["model", "hooks", "enabledPlugins"], "se desordena el settings.json de la persona");
        assert!(handlers(&once, "PreToolUse").contains(&"~/.claude/hooks/relevo".to_string()));
        assert!(handlers(&once, "SessionStart").contains(&"~/.claude/hooks/cbm".to_string()));
        assert_eq!(handlers(&once, "SessionStart").iter().filter(|c| ours(c, "cac-session")).count(), 4);
        assert_eq!(handlers(&once, "Stop").len(), 1);

        // Otra carpeta: la entrada vieja se va, no se suma.
        let moved = merge_settings(once, Path::new("/otra/hooks/cac")).unwrap();
        let stop = handlers(&moved, "Stop");
        assert_eq!(stop.len(), 1);
        assert!(stop[0].contains("/otra/hooks/cac/cac-handoff"), "{stop:?}");
        let post = &moved["hooks"]["PostToolUse"][0];
        assert_eq!(post["matcher"], "mcp__cac__.*");
    }

    /// Rotura que detecta: instalar sin los ficheros, sin permiso de
    /// ejecución, sin las entradas, o pisar un settings.json que no es JSON.
    #[test]
    fn install_writes_the_scripts_and_the_state_follows() {
        let d = tmp("install");
        assert_eq!(state(&d), HooksState::Missing);
        assert!(install(&d, true).unwrap()["dryRun"] == json!(true));
        assert!(!hooks_dir(&d).exists(), "un dryRun escribe");

        install(&d, false).unwrap();
        for (name, text) in HOOK_FILES {
            assert_eq!(std::fs::read_to_string(hooks_dir(&d).join(name)).unwrap(), *text);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(hooks_dir(&d).join("cac-session")).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
        }
        assert_eq!(state(&d), HooksState::Current);

        // Una copia de antes de la marca: se ofrece actualizar.
        std::fs::write(hooks_dir(&d).join("cac_hooks.py"), "# vieja").unwrap();
        assert_eq!(state(&d), HooksState::Outdated);

        // Sin sus entradas, los ficheros solos no corren.
        install(&d, false).unwrap();
        std::fs::write(d.join("settings.json"), "{}").unwrap();
        assert_eq!(state(&d), HooksState::Missing);

        std::fs::write(d.join("settings.json"), "{ esto no es json").unwrap();
        assert!(install(&d, false).is_err());
        assert_eq!(std::fs::read_to_string(d.join("settings.json")).unwrap(), "{ esto no es json");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn the_shipped_hooks_carry_a_version() {
        assert!(shipped_version().is_some(), "cac_hooks.py sin `# cac-hooks vN`: nunca se ofrecería actualizar");
        assert!(ours("python3 \"/home/x/.claude/hooks/cac/cac-wrote\"", "cac-wrote"));
        assert!(ours("python \"C:\\Users\\x\\.claude\\hooks\\cac\\cac-wrote\"", "cac-wrote"));
        assert!(!ours("\"$(git rev-parse --show-toplevel)/.claude/hooks/cac-wrote\"", "cac-wrote"), "la del repo no es la global");
    }
}
