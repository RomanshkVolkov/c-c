//! Lanzar programas del sistema desde la app sin el entorno de la AppImage.
//!
//! Dentro de una AppImage, la app lleva una veintena de variables que apuntan
//! a la imagen montada (`LD_LIBRARY_PATH`, `GTK_PATH`, `PYTHONHOME`, las de
//! GStreamer…), y cualquier programa que lance las hereda. El del sistema carga
//! entonces las bibliotecas de la imagen, de Ubuntu 22.04, en vez de las suyas:
//!
//! ```text
//! /bin/sh: symbol lookup error: /bin/sh: undefined symbol: rl_trim_arg_from_keyseq
//! ```
//!
//! Es el `bash` del sistema con la `libreadline` vieja de la imagen. Ya mordió
//! dos veces por separado: el relanzado tras actualizar (`relaunch.rs`) y el
//! Python de Ansible (`ansible.rs`). La tercera, el 21-oct-2026: tras un
//! `pacman -Syu`, ningún enlace externo abría («antes abría bien», jose). El
//! plugin de Tauri abre con `xdg-open`, que es un script de shell, y moría sin
//! decir nada. Medido lanzando `xdg-open` con el entorno de la app en marcha:
//! con él, el error de arriba; sin él, Firefox abre.
//!
//! Así que todo lo que la app lanza del sistema pasa por aquí: `command` en vez
//! de `Command::new`, y `open_url` / `open_path` en vez del plugin. Fuera de una
//! AppImage no hay nada que limpiar y esto no cambia nada.

use std::ffi::OsStr;
use std::process::Command;

/// Lo que la AppImage mete en el entorno y no puede llegar a un programa del
/// sistema: las variables que apuntan dentro de `$APPDIR` y las de la propia
/// imagen. Devuelve qué quitar y el `PATH` sin carpetas de la imagen. Fuera de
/// una AppImage (sin `APPDIR`) no toca nada.
pub fn appimage_cleanup(env: &[(String, String)]) -> (Vec<String>, Option<String>) {
    let Some(appdir) = env.iter().find(|(k, _)| k == "APPDIR").map(|(_, v)| v.trim_end_matches('/').to_string()) else {
        return (vec![], None);
    };
    if appdir.is_empty() {
        return (vec![], None);
    }
    let mut remove: Vec<String> = env
        .iter()
        .filter(|(k, v)| k != "PATH" && v.contains(&appdir))
        .map(|(k, _)| k.clone())
        .collect();
    for k in ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "PYTHONDONTWRITEBYTECODE"] {
        if env.iter().any(|(x, _)| x == k) && !remove.iter().any(|r| r == k) {
            remove.push(k.to_string());
        }
    }
    let path = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| {
        v.split(':').filter(|p| !p.is_empty() && !p.starts_with(&appdir)).collect::<Vec<_>>().join(":")
    });
    (remove, path)
}

/// Un programa del sistema, listo para lanzar con el entorno limpio.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    clean(&mut cmd);
    cmd
}

/// Limpia el entorno de un `Command` ya creado.
pub fn clean(cmd: &mut Command) {
    let env: Vec<(String, String)> = std::env::vars().collect();
    clean_with(cmd, &env);
}

/// `clean` con el entorno dado, en vez del de esta app (para probarlo).
fn clean_with(cmd: &mut Command, env: &[(String, String)]) {
    let (remove, path) = appimage_cleanup(env);
    for k in remove {
        cmd.env_remove(k);
    }
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
}

/// Lo mismo para un `CommandBuilder` de un pty (la terminal).
pub fn clean_pty(cmd: &mut portable_pty::CommandBuilder) {
    let env: Vec<(String, String)> = std::env::vars().collect();
    let (remove, path) = appimage_cleanup(&env);
    for k in remove {
        cmd.env_remove(k);
    }
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
}

/// Qué enlaces se abren fuera: los de la web y el correo. Un `file://` o un
/// esquema raro que llegara de una página no se le pasa al sistema.
pub fn is_openable_url(url: &str) -> bool {
    let u = url.trim();
    u.starts_with("https://") || u.starts_with("http://") || u.starts_with("mailto:")
}

/// Con qué programas se intenta abrir `target`, en orden: los mismos que el
/// plugin `opener` (`open::commands`: `wslview` dentro de WSL, `xdg-open`,
/// `gio open`, `gnome-open`, `kde-open`), y al final el `xdg-open` que la
/// AppImage lleva dentro. Ese último es el que tiene una distro sin
/// `xdg-utils`: el plugin lo encontraba por el `PATH` de la imagen, y aquí ese
/// `PATH` se limpia, así que se nombra por su ruta.
#[cfg(target_os = "linux")]
fn launchers(target: &str, env: &[(String, String)]) -> Vec<Command> {
    let mut out = open::commands(target);
    let appdir = env.iter().find(|(k, _)| k == "APPDIR").map(|(_, v)| v.as_str());
    if let Some(dir) = appdir.filter(|d| !d.is_empty()) {
        let bundled = std::path::Path::new(dir).join("usr/bin/xdg-open");
        if bundled.exists() {
            let mut c = Command::new(bundled);
            c.arg(target);
            out.push(c);
        }
    }
    for c in &mut out {
        clean_with(c, env);
    }
    out
}

/// Lanza el primero de `launchers` que exista y espera un momento a ver si
/// muere al arrancar, que es como fallaba con el entorno de la imagen, para que
/// el error llegue a la página en vez de perderse. Si sigue vivo, ya está: con
/// Firefox cerrado, `xdg-open` no vuelve hasta que se cierre el navegador.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn launch_first(launchers: Vec<Command>) -> Result<(), String> {
    let mut missing = vec![];
    for mut cmd in launchers {
        let name = cmd.get_program().to_string_lossy().to_string();
        let child = cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                missing.push(name);
                continue;
            }
            Err(e) => return Err(format!("Could not run {name}: {e}")),
        };
        for _ in 0..30 {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(status)) => {
                    let mut err = String::new();
                    if let Some(mut e) = child.stderr.take() {
                        use std::io::Read;
                        let _ = e.read_to_string(&mut err);
                    }
                    return Err(format!("{name} failed ({status}): {}", err.trim()));
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(e) => return Err(e.to_string()),
            }
        }
        // Sigue abriendo: que acabe solo, sin dejar un proceso zombi.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        return Ok(());
    }
    Err(format!("Nothing to open it with: none of {} is installed", missing.join(", ")))
}

#[cfg(target_os = "linux")]
fn open_with_system(target: &str) -> Result<(), String> {
    let env: Vec<(String, String)> = std::env::vars().collect();
    launch_first(launchers(target, &env))
}

#[cfg(not(target_os = "linux"))]
fn open_with_system(target: &str) -> Result<(), String> {
    tauri_plugin_opener::open_path(target, None::<&str>).map_err(|e| e.to_string())
}

/// Abre un enlace en el navegador del sistema. Desde la página, en vez del
/// `openUrl` del plugin (ver arriba). En macOS y Windows sigue el plugin: allí
/// no hay AppImage, y nada cambia.
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !is_openable_url(&url) {
        return Err("Only http(s) and mailto links are opened outside the app".into());
    }
    #[cfg(not(target_os = "linux"))]
    {
        return tauri_plugin_opener::open_url(url.trim(), None::<&str>).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "linux")]
    tauri::async_runtime::spawn_blocking(move || open_with_system(url.trim()))
        .await
        .map_err(|e| e.to_string())?
}

/// Abre un fichero con la app que el sistema tenga para él.
pub fn open_path(path: &std::path::Path) -> Result<(), String> {
    open_with_system(&path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// Roturas que detecta: dejar `LD_LIBRARY_PATH` (el bash del sistema
    /// cargaría la readline vieja), dejar las de la imagen, tocar lo que no
    /// apunta a la imagen, o dejar sus carpetas en el PATH.
    #[test]
    fn inside_an_appimage_everything_that_points_at_it_goes() {
        let e = env(&[
            ("APPDIR", "/tmp/.mount_cac.X"),
            ("APPIMAGE", "/home/rv/cac.AppImage"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_cac.X/usr/lib:/tmp/.mount_cac.X/lib"),
            ("XDG_DATA_DIRS", "/tmp/.mount_cac.X/usr/share:/usr/share"),
            ("PATH", "/tmp/.mount_cac.X/usr/bin:/usr/bin:/bin"),
            ("HOME", "/home/rv"),
            ("SSH_AUTH_SOCK", "/home/rv/.1password/agent.sock"),
        ]);
        let (remove, path) = appimage_cleanup(&e);
        for k in ["LD_LIBRARY_PATH", "XDG_DATA_DIRS", "APPDIR", "APPIMAGE"] {
            assert!(remove.iter().any(|r| r == k), "{k} tiene que quitarse");
        }
        for k in ["HOME", "SSH_AUTH_SOCK", "PATH"] {
            assert!(!remove.iter().any(|r| r == k), "{k} no se toca");
        }
        assert_eq!(path.as_deref(), Some("/usr/bin:/bin"));
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        assert_eq!(appimage_cleanup(&env(&[("HOME", "/h"), ("PATH", "/usr/bin")])), (vec![], None));
    }

    /// Roturas que detectan: rendirse con el primer programa que no está
    /// (una distro sin `xdg-open` pero con `gio` dejaría de abrir), dar por
    /// bueno uno que muere al arrancar (el fallo que no se veía), o no decir
    /// nada cuando no hay ninguno.
    #[test]
    #[cfg(unix)]
    fn the_first_launcher_that_exists_is_used_and_its_failure_is_reported() {
        let cmd = |p: &str, args: &[&str]| {
            let mut c = Command::new(p);
            c.args(args);
            c
        };
        assert!(launch_first(vec![cmd("cac-no-existe-1", &[]), cmd("true", &[])]).is_ok());
        let err = launch_first(vec![cmd("cac-no-existe-1", &[]), cmd("sh", &["-c", "echo roto >&2; exit 127"])]).unwrap_err();
        assert!(err.contains("127") && err.contains("roto"), "{err}");
        let none = launch_first(vec![cmd("cac-no-existe-1", &[]), cmd("cac-no-existe-2", &[])]).unwrap_err();
        assert!(none.contains("cac-no-existe-1") && none.contains("cac-no-existe-2"), "{none}");
    }

    /// Roturas que detectan: perder los programas que probaba el plugin, o el
    /// `xdg-open` de la imagen (el único en una distro sin `xdg-utils`), o
    /// lanzarlos con el entorno de la imagen.
    #[test]
    #[cfg(target_os = "linux")]
    fn the_launchers_are_the_plugins_plus_the_one_in_the_image() {
        let dir = std::env::temp_dir().join(format!("cac-launchers-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("usr/bin")).unwrap();
        std::fs::write(dir.join("usr/bin/xdg-open"), "#!/bin/sh\n").unwrap();
        let appdir = dir.to_string_lossy().to_string();
        let env = vec![
            ("APPDIR".to_string(), appdir.clone()),
            ("LD_LIBRARY_PATH".to_string(), format!("{appdir}/usr/lib")),
        ];
        let all = launchers("https://x", &env);
        let names: Vec<String> = all.iter().map(|c| c.get_program().to_string_lossy().to_string()).collect();
        // A cada uno se le quita lo de la imagen.
        for c in &all {
            assert!(
                c.get_envs().any(|(k, v)| k == "LD_LIBRARY_PATH" && v.is_none()),
                "{:?} hereda el LD_LIBRARY_PATH de la imagen",
                c.get_program()
            );
        }
        for p in ["xdg-open", "gio", "gnome-open", "kde-open"] {
            assert!(names.iter().any(|n| n == p), "falta {p}: {names:?}");
        }
        assert_eq!(names.last().unwrap(), &dir.join("usr/bin/xdg-open").to_string_lossy().to_string());
        // Sin AppImage, sólo los del plugin.
        assert!(!launchers("https://x", &[]).iter().any(|c| c.get_program().to_string_lossy().contains("usr/bin")));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Nadie lanza un programa del sistema por fuera de aquí. Rotura que
    /// detecta: un `Command::new("programa")` nuevo, que heredaría el entorno
    /// de la imagen y moriría igual que `xdg-open`. Sólo mira el código, no
    /// las pruebas (lo que va tras `#[cfg(test)]`).
    #[test]
    fn every_system_program_is_launched_through_here() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut bad = vec![];
        for entry in std::fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            if p.extension().and_then(|e| e.to_str()) != Some("rs") || p.ends_with("host.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&p).unwrap();
            let code = text.split("#[cfg(test)]").next().unwrap_or("");
            for (i, line) in code.lines().enumerate() {
                if line.contains("Command::new(\"") || line.contains("CommandBuilder::new(\"") && !code.contains("clean_pty") {
                    bad.push(format!("{}:{}: {}", p.file_name().unwrap().to_string_lossy(), i + 1, line.trim()));
                }
            }
        }
        assert!(bad.is_empty(), "lanzan un programa sin limpiar el entorno: {bad:#?}");
    }

    /// Rotura que detecta: pasarle al sistema un `file://` o un esquema
    /// cualquiera que llegue de una página.
    #[test]
    fn only_web_and_mail_links_are_opened() {
        for ok in ["https://github.com/x", "http://localhost:1420", "mailto:a@b.c", "  https://x "] {
            assert!(is_openable_url(ok), "{ok}");
        }
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "/home/rv/.ssh", "smb://x", ""] {
            assert!(!is_openable_url(bad), "{bad}");
        }
    }

    /// De punta a punta, con un fallo como el que se midió: una variable de la
    /// imagen que no deja arrancar a la shell. Limpia, la shell arranca.
    /// Rotura que detecta: que `clean` no le quite al proceso lo de la imagen.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_command_does_not_inherit_the_image_environment() {
        let dir = std::env::temp_dir().join(format!("cac-host-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Una «biblioteca» que no es una biblioteca: con ella en
        // LD_PRELOAD, el cargador se queja al arrancar cualquier programa.
        let fake = dir.join("libroto.so");
        std::fs::write(&fake, b"no soy un ELF").unwrap();
        let appdir = dir.to_string_lossy().to_string();
        let run = |clean_it: bool| {
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg("exit 0");
            cmd.env("APPDIR", &appdir).env("LD_PRELOAD", fake.to_string_lossy().to_string());
            if clean_it {
                let env = vec![
                    ("APPDIR".to_string(), appdir.clone()),
                    ("LD_PRELOAD".to_string(), fake.to_string_lossy().to_string()),
                ];
                clean_with(&mut cmd, &env);
            }
            cmd.output().unwrap()
        };
        let dirty = run(false);
        assert!(String::from_utf8_lossy(&dirty.stderr).contains("libroto"), "el entorno sucio tenía que romperla: {dirty:?}");
        let clean = run(true);
        assert!(clean.status.success() && !String::from_utf8_lossy(&clean.stderr).contains("libroto"), "limpia, la shell no vio la imagen: {clean:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
