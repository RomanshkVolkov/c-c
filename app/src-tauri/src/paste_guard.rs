//! Pegar no puede tumbar la app (Linux, WebKitGTK).
//!
//! WebKitGTK 2.54.1 muere al pegar si el portapapeles no tiene dueño que
//! conteste: vacío, de una app que ya se cerró, o de un dueño que no responde.
//! Al pegar, WebKit pide la lista de formatos (`gtk_clipboard_request_targets`);
//! cuando la petición falla GTK contesta con un puntero nulo y `-1`, y
//! `WebKit::Clipboard::formats` (UIProcess/gtk/ClipboardGtk3.cpp:81) no lo mira:
//! convierte el `-1` en un tamaño, recorre la lista y lee la dirección 0. Es un
//! SIGSEGV del proceso de la app, no de la página: se cierra la ventana entera
//! (20-oct-2026, tres veces en una noche; símbolos sacados del core con
//! debuginfod).
//!
//! No se puede arreglar desde la página: el fallo ocurre al atender la tecla,
//! antes de que llegue el evento `paste`. Se ataja un paso antes, en GTK: al
//! pulsar pegar se pregunta lo mismo con la llamada síncrona
//! (`gtk_clipboard_wait_for_targets`), que sí trata el fallo, y si no hay
//! formatos se descarta la pulsación — no había nada que pegar. Si los hay,
//! WebKit pega como siempre.
//!
//! Cubre el teclado (Ctrl+V, Ctrl+Shift+V, Shift+Insert, la tecla Paste) y el
//! clic central, que pega la selección PRIMARY por el mismo camino.

/// Si una pulsación pide pegar. `keyval` en minúsculas o mayúsculas da igual.
pub fn is_paste_key(keyval: u32, ctrl: bool, shift: bool) -> bool {
    // Valores de gdk/gdkkeysyms.h; aquí sin depender de gdk para poder
    // probarlo sin pantalla.
    const KEY_V: u32 = 0x076;
    const KEY_V_UPPER: u32 = 0x056;
    const KEY_INSERT: u32 = 0xff63;
    const KEY_KP_INSERT: u32 = 0xff9e;
    const KEY_PASTE: u32 = 0x1008ff6d; // XF86Paste
    match keyval {
        KEY_V | KEY_V_UPPER => ctrl,
        KEY_INSERT | KEY_KP_INSERT => shift && !ctrl,
        KEY_PASTE => true,
        _ => false,
    }
}

/// Si hay que tragarse el pegado: cuando el portapapeles no dio formatos. Una
/// lista vacía también: no hay nada que WebKit pueda pegar, y es el mismo caso
/// para él.
pub fn should_block(targets: Option<usize>) -> bool {
    !matches!(targets, Some(n) if n > 0)
}

#[cfg(target_os = "linux")]
pub fn install(webview: &webkit2gtk::WebView) {
    use gtk::prelude::*;

    fn has_targets(selection: &gtk::gdk::Atom) -> bool {
        let n = gtk::Clipboard::get(selection).wait_for_targets().map(|t| t.len());
        !should_block(n)
    }

    webview.connect_key_press_event(|_, ev| {
        let state = ev.state();
        let paste = is_paste_key(
            *ev.keyval(),
            state.contains(gtk::gdk::ModifierType::CONTROL_MASK),
            state.contains(gtk::gdk::ModifierType::SHIFT_MASK),
        );
        if paste && !has_targets(&gtk::gdk::SELECTION_CLIPBOARD) {
            return gtk::glib::Propagation::Stop;
        }
        gtk::glib::Propagation::Proceed
    });

    webview.connect_button_press_event(|_, ev| {
        if ev.button() == 2 && !has_targets(&gtk::gdk::SELECTION_PRIMARY) {
            return gtk::glib::Propagation::Stop;
        }
        gtk::glib::Propagation::Proceed
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_every_way_to_paste() {
        assert!(is_paste_key(0x076, true, false), "Ctrl+V");
        assert!(is_paste_key(0x056, true, true), "Ctrl+Shift+V");
        assert!(is_paste_key(0xff63, false, true), "Shift+Insert");
        assert!(is_paste_key(0x1008ff6d, false, false), "tecla Paste");
        assert!(!is_paste_key(0x076, false, false), "una v suelta se escribe");
        assert!(!is_paste_key(0xff63, true, false), "Ctrl+Insert es copiar");
        assert!(!is_paste_key(0xff63, true, true), "con Ctrl, Insert no pega");
        assert!(!is_paste_key(0x063, true, false), "Ctrl+C no es pegar");
    }

    #[test]
    fn no_formats_means_no_paste() {
        assert!(should_block(None), "la petición falló: es el caso que tumba WebKit");
        assert!(should_block(Some(0)));
        assert!(!should_block(Some(3)));
    }
}
