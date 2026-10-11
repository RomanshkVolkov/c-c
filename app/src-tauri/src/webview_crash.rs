//! Cuando el proceso que pinta la página se muere.
//!
//! En Linux la página no corre en el proceso de cac sino en `WebKitWebProcess`.
//! Si ése aborta, la ventana sigue viva pero vacía, y **nada de la página
//! puede enterarse**: el `ErrorBoundary` y `fileCrash` son JS, y mueren con
//! ella. El 10-oct-2026 un vídeo lo tumbó dos veces seguidas (GStreamer sin
//! `autoaudiosink` en la AppImage) y lo único que se vio fue una pantalla en
//! negro que no volvía; el rastro estaba sólo en `coredumpctl`.
//!
//! Así que el guardián está aquí, fuera: WebKit avisa con
//! `web-process-terminated`, se apunta qué pasó y se recarga la página. Al
//! volver, la app pregunta (`take_webview_crash`) y lo ficha en cac como
//! cualquier otro fallo.
//!
//! Con un tope: si se cae [`TOPE_RECARGAS`] veces en [`VENTANA_MS`], se deja
//! de recargar. Una página que muere al arrancar, recargada sin fin, es un
//! bucle que se come la CPU y no deja ni cerrar.

use std::sync::Mutex;

/// Lo que la página encuentra al volver.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewCrash {
    /// `crashed`, `memory` o `api`: lo que dijo WebKit.
    pub reason: String,
    /// Dónde estaba la página cuando se cayó: la mitad de reproducirlo.
    pub url: String,
    /// Cuándo, en milisegundos desde 1970.
    pub at_ms: u64,
    /// Cuántas veces en la ventana: si son varias, no fue mala suerte.
    pub count: u32,
}

pub const TOPE_RECARGAS: usize = 3;
pub const VENTANA_MS: u64 = 60_000;

#[derive(Default)]
struct Estado {
    pendiente: Option<WebviewCrash>,
    caidas: Vec<u64>,
}

static ESTADO: Mutex<Estado> = Mutex::new(Estado { pendiente: None, caidas: Vec::new() });

/// Apunta una caída y dice si hay que recargar.
fn anotar(estado: &mut Estado, reason: &str, url: &str, ahora_ms: u64) -> bool {
    estado.caidas.retain(|&t| ahora_ms.saturating_sub(t) < VENTANA_MS);
    estado.caidas.push(ahora_ms);
    let count = estado.caidas.len() as u32;
    estado.pendiente = Some(WebviewCrash {
        reason: reason.to_string(),
        url: url.to_string(),
        at_ms: ahora_ms,
        count,
    });
    estado.caidas.len() < TOPE_RECARGAS + 1
}

/// Lo llama el manejador de la señal. Devuelve si hay que recargar.
pub fn on_terminated(reason: &str, url: &str) -> bool {
    let ahora = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    eprintln!("[webview] el proceso de la página terminó ({reason}) en {url}");
    let mut estado = ESTADO.lock().unwrap_or_else(|e| e.into_inner());
    anotar(&mut estado, reason, url, ahora)
}

/// La página, al volver: lo que pasó, una sola vez.
#[tauri::command]
pub fn take_webview_crash() -> Option<WebviewCrash> {
    tomar(&mut ESTADO.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Una sola vez: otra recarga de la página no la vuelve a fichar.
fn tomar(estado: &mut Estado) -> Option<WebviewCrash> {
    estado.pendiente.take()
}

#[cfg(target_os = "linux")]
pub fn reason_name(r: webkit2gtk::WebProcessTerminationReason) -> &'static str {
    use webkit2gtk::WebProcessTerminationReason as R;
    match r {
        R::Crashed => "crashed",
        R::ExceededMemoryLimit => "memory",
        R::TerminatedByApi => "api",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_caida_se_apunta_y_se_recarga() {
        let mut e = Estado::default();
        assert!(anotar(&mut e, "crashed", "tauri://localhost/#/channels", 1_000));
        let c = e.pendiente.clone().unwrap();
        assert_eq!(c.reason, "crashed");
        assert_eq!(c.url, "tauri://localhost/#/channels");
        assert_eq!(c.at_ms, 1_000);
        assert_eq!(c.count, 1);
    }

    #[test]
    fn se_lee_una_sola_vez() {
        let mut e = Estado::default();
        anotar(&mut e, "crashed", "u", 1);
        assert!(tomar(&mut e).is_some());
        assert!(tomar(&mut e).is_none());
    }

    #[test]
    fn un_bucle_de_caidas_deja_de_recargar() {
        let mut e = Estado::default();
        for i in 0..TOPE_RECARGAS as u64 {
            assert!(anotar(&mut e, "crashed", "u", i * 1_000), "la caída {i} recarga");
        }
        assert!(!anotar(&mut e, "crashed", "u", 10_000), "la de más ya no");
        assert_eq!(e.pendiente.as_ref().unwrap().count, TOPE_RECARGAS as u32 + 1);
    }

    #[test]
    fn las_caidas_viejas_no_cuentan_para_el_tope() {
        let mut e = Estado::default();
        for i in 0..TOPE_RECARGAS as u64 {
            anotar(&mut e, "crashed", "u", i);
        }
        assert!(anotar(&mut e, "crashed", "u", VENTANA_MS + 10));
        assert_eq!(e.pendiente.as_ref().unwrap().count, 1);
    }
}
