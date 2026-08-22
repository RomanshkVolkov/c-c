//! Enlaza GLib/GIO, que es lo que el capturador de escritorio necesita en Linux.
//!
//! Sin esto, `cargo build --bin video` muere con `undefined symbol:
//! g_dbus_connection_signal_subscribe` y una docena más. El capturador de
//! PipeWire de libwebrtc habla con **xdg-desktop-portal por D-Bus**, así que
//! arrastra GIO — y el `.a` precompilado trae los objetos pero no las
//! dependencias del sistema.
//!
//! La app de Tauri no necesita este apaño: ya enlaza GTK, y GTK arrastra GIO.
//! Aquí hace falta porque el spike es un binario pelado, y eso lo convierte en
//! una prueba más honesta: enseña la dependencia real en vez de esconderla
//! detrás de lo que otro ya enlazó.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        for lib in ["gio-2.0", "glib-2.0", "gobject-2.0"] {
            println!("cargo:rustc-link-lib=dylib={lib}");
        }
    }
}
