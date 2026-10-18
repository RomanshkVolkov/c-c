//! Las zonas horarias del ICU del WebKit de Linux (ver
//! `resources/icu-tz/README.md`): la AppImage trae un ICU 70 con datos de
//! 2021 que todavía cree que México cambia la hora en verano, y todas las
//! horas de la app salían una de más de abril a octubre.

use std::path::{Path, PathBuf};

/// La versión de tzdata que va en `resources/icu-tz`.
pub const ICU_TZDATA_VERSION: &str = "2026e";

/// Dónde pueden estar los datos, según dónde esté el ejecutable: junto a él
/// en desarrollo (`target/debug/icu-tz`), y en `../lib/CAC/icu-tz` en la
/// AppImage y el .deb, que es donde Tauri deja los recursos en Linux.
pub fn candidates(exe: &Path) -> Vec<PathBuf> {
    let Some(dir) = exe.parent() else { return vec![] };
    vec![dir.join("icu-tz"), dir.join("../lib/CAC/icu-tz")]
}

/// Apunta `ICU_TIMEZONE_FILES_DIR` a los datos actualizados, si están y si
/// nadie lo apuntó antes. Tiene que ir antes de abrir la webview: el proceso
/// de WebKit hereda el entorno al arrancar.
pub fn use_bundled_timezones() {
    if std::env::var_os("ICU_TIMEZONE_FILES_DIR").is_some() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    if let Some(dir) = candidates(&exe).into_iter().find(|d| d.join("zoneinfo64.res").is_file()) {
        std::env::set_var("ICU_TIMEZONE_FILES_DIR", dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Los cuatro ficheros de zonas van con la app, y se buscan donde Tauri
    /// deja los recursos en Linux. Mutantes: olvidar un fichero (ICU cae a
    /// sus datos viejos); buscar en otra carpeta.
    #[test]
    fn the_timezone_data_ships_and_is_found() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/icu-tz");
        for f in ["zoneinfo64.res", "metaZones.res", "timezoneTypes.res", "windowsZones.res"] {
            assert!(dir.join(f).is_file(), "falta {f}");
        }
        let c = candidates(Path::new("/tmp/.mount_cac/usr/bin/app"));
        assert!(c.contains(&PathBuf::from("/tmp/.mount_cac/usr/bin/../lib/CAC/icu-tz")), "{c:?}");
    }

    /// La configuración empaqueta esa carpeta con ese nombre.
    #[test]
    fn the_bundle_declares_the_timezone_data() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["bundle"]["resources"]["resources/icu-tz/"], "icu-tz/");
        assert_eq!(conf["productName"], "CAC", "los recursos de Linux van en lib/<productName>");
    }
}
