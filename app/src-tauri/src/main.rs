// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // MCP server mode: the same binary doubles as a stdio MCP server so an LLM
    // client can read reports/diagnostics live. Must branch before any GUI
    // initialization — and before anything can write to stdout, which from here
    // on carries JSON-RPC only.
    if std::env::args().any(|a| a == "--mcp") {
        app_lib::serve_mcp();
        return;
    }

    // WebKitGTK's DMABUF renderer fails to allocate an EGL display on hybrid
    // Intel+NVIDIA setups (EGL_BAD_ALLOC), aborting the process on launch.
    // Disabling it forces a working fallback path. Linux-only; must be set
    // before the webview initializes.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    app_lib::run()
}
