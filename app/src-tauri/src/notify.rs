//! Los avisos del sistema, con el nombre y el logo de cac.
//!
//! En Linux el plugin de notificaciones no pasa ni nombre ni icono, y
//! `notify-rust` cae entonces al nombre del ejecutable, que dentro de la
//! AppImage es `app`: el aviso salía firmado «app» y sin logo (14-oct-2026).
//! Aquí, en Linux, se manda con `notify-rust` directamente, con el nombre de
//! la app y el logo escrito una vez en la caché (un servidor de avisos pide
//! una ruta o un nombre de icono del tema, no bytes). En macOS y Windows el
//! sistema ya pone el icono de la app, y sigue el plugin.

/// Lo que se firma en el aviso.
pub const APP_NAME: &str = "C-C";

/// El logo, dentro del binario: la AppImage no instala iconos en el sistema.
#[cfg(target_os = "linux")]
const ICON: &[u8] = include_bytes!("../icons/128x128.png");

/// Escribe el logo en `dir` si no está o cambió, y devuelve su ruta.
#[cfg(target_os = "linux")]
pub fn icon_in(dir: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let path = dir.join("notification-icon.png");
    if std::fs::read(&path).ok().as_deref() != Some(ICON) {
        std::fs::create_dir_all(dir)?;
        std::fs::write(&path, ICON)?;
    }
    Ok(path)
}

#[tauri::command]
pub fn desktop_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let mut n = notify_rust::Notification::new();
        n.appname(APP_NAME).summary(&title).body(&body);
        if let Some(icon) = app
            .path()
            .app_cache_dir()
            .ok()
            .and_then(|d| icon_in(&d).ok())
        {
            n.icon(&icon.to_string_lossy());
        }
        // En otro hilo: el servidor de avisos por D-Bus puede tardar, y esto
        // no puede frenar a quien lo pidió.
        std::thread::spawn(move || {
            let _ = n.show();
        });
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// El logo se escribe una vez y se rehace si alguien lo pisa.
    /// Mutantes: no escribirlo; no comparar (no se rehace).
    #[test]
    fn the_icon_is_written_once_and_repaired() {
        let dir = std::env::temp_dir().join(format!("cac-notify-icon-{}", std::process::id()));
        let p = icon_in(&dir).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), ICON);
        std::fs::write(&p, b"roto").unwrap();
        icon_in(&dir).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), ICON);
        let _ = std::fs::remove_dir_all(dir);
    }
}
