//! Relanzar la app tras actualizarla, también desde una AppImage.
//!
//! El `relaunch()` de Tauri lanza la AppImage nueva **heredando el entorno de la
//! vieja**, y la vieja todavía está viva cuando la nueva arranca. Ese entorno
//! lleva una veintena de variables que apuntan al montaje de la vieja
//! (`LD_LIBRARY_PATH`, `GTK_PATH`, las de GStreamer…). El `AppRun` de la nueva
//! es un script de bash, y el bash del sistema, con ese `LD_LIBRARY_PATH`, carga
//! la `libreadline` de Ubuntu 22.04 que trae la imagen y muere:
//!
//! ```text
//! bash: symbol lookup error: bash: undefined symbol: rl_trim_arg_from_keyseq
//! ```
//!
//! La vieja sale, la nueva nunca llegó a abrirse, y no queda ninguna: «cuando
//! actualizo no se relanza» (jose, desde la v1.6.9x). Medido el 16-oct-2026:
//! el error está en el diario de la sesión justo al reemplazarse la AppImage, y
//! se reproduce lanzándola con el entorno de la app en marcha. Con el entorno
//! limpio, la misma AppImage abre su ventana.
//!
//! Así que se relanza con el entorno limpio de la imagen, el mismo que ya usa
//! `ansible.rs` para lanzar Python (`appimage_cleanup`). Fuera de una AppImage
//! no hay nada que limpiar y se usa el relanzado de Tauri.

use std::path::PathBuf;
use std::process::Command;

/// Qué lanzar y con qué entorno: el fichero de la AppImage (no el binario de
/// dentro del montaje, que desaparece con la vieja), las variables que quitar y
/// el `PATH` limpio. `None` fuera de una AppImage.
pub fn relaunch_plan(env: &[(String, String)]) -> Option<(PathBuf, Vec<String>, Option<String>)> {
    let appimage = env.iter().find(|(k, _)| k == "APPIMAGE").map(|(_, v)| v.clone())?;
    if appimage.is_empty() {
        return None;
    }
    let (remove, path) = crate::host::appimage_cleanup(env);
    Some((PathBuf::from(appimage), remove, path))
}

/// Relanza la app. Desde la página, en vez del `relaunch()` del plugin.
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    let env: Vec<(String, String)> = std::env::vars().collect();
    let Some((target, remove, path)) = relaunch_plan(&env) else {
        app.restart();
    };
    let mut cmd = Command::new(&target);
    cmd.args(std::env::args_os().skip(1));
    for k in &remove {
        cmd.env_remove(k);
    }
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
    // Al diario de la sesión, que es donde se ve la salida de la app: si un día
    // vuelve a fallar, aquí queda dicho qué se lanzó.
    match cmd.spawn() {
        Ok(child) => eprintln!(
            "relaunch: {} (pid {}), sin {} variables de la imagen",
            target.display(),
            child.id(),
            remove.len()
        ),
        Err(e) => {
            eprintln!("relaunch: no se pudo lanzar {}: {e}; se usa el de Tauri", target.display());
            app.restart();
        }
    }
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// Dentro de una AppImage se relanza el fichero, sin nada que apunte al
    /// montaje viejo. Mutantes: lanzar el binario del montaje; dejar
    /// `LD_LIBRARY_PATH` (el bash del `AppRun` cargaría la readline vieja).
    #[test]
    fn inside_an_appimage_it_relaunches_the_file_with_a_clean_environment() {
        let e = env(&[
            ("APPIMAGE", "/home/rv/cac.AppImage"),
            ("APPDIR", "/tmp/.mount_cac.X"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_cac.X/usr/lib:/tmp/.mount_cac.X/usr/lib/x86_64-linux-gnu"),
            ("GTK_PATH", "/tmp/.mount_cac.X/usr/lib/gtk-3.0"),
            ("PATH", "/tmp/.mount_cac.X/usr/bin:/usr/bin:/bin"),
            ("HOME", "/home/rv"),
        ]);
        let (target, remove, path) = relaunch_plan(&e).unwrap();
        assert_eq!(target, PathBuf::from("/home/rv/cac.AppImage"));
        for k in ["LD_LIBRARY_PATH", "GTK_PATH", "APPDIR", "APPIMAGE"] {
            assert!(remove.iter().any(|r| r == k), "{k} tiene que quitarse");
        }
        assert!(!remove.iter().any(|r| r == "HOME"));
        assert_eq!(path.as_deref(), Some("/usr/bin:/bin"));
    }

    /// Fuera de una AppImage no hay plan propio: se usa el de Tauri.
    #[test]
    fn outside_an_appimage_there_is_nothing_to_clean() {
        assert!(relaunch_plan(&env(&[("HOME", "/home/rv"), ("PATH", "/usr/bin")])).is_none());
    }
}
