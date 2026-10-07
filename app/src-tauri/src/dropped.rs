//! Un fichero soltado (o pegado) desde un gestor de ficheros.
//!
//! En Linux, WebKitGTK entrega lo que suelta Thunar sólo como `text/uri-list`
//! —la dirección `file:///…`—, no los bytes, y el webview no puede leer una
//! ruta del disco. El editor le pide aquí el fichero (jose, 6-oct-2026).
//!
//! «Leer un fichero por su ruta» es justo lo que querría un script colado, así
//! que esto sólo sirve **lo que se adjunta**: ficheros normales, como mucho del
//! tope de subida, y de una lista cerrada de tipos (imágenes, PDF, oficina,
//! audio, vídeo, zip, csv). Nada de llaves, `.env`, `.json` ni texto. La
//! extensión se mira en la ruta **real**, ya resueltos los enlaces simbólicos:
//! un `foto.png` que apunte a `~/.ssh/id_rsa` no pasa.

use std::path::{Path, PathBuf};

/// El tope de una subida (`maxAttachmentBytes` en el backend).
pub const MAX_BYTES: u64 = 30 * 1024 * 1024;

/// Lo que se puede adjuntar desde el disco.
const ALLOWED: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "pdf", "doc", "docx", "xls", "xlsx",
    "ppt", "pptx", "odt", "ods", "odp", "csv", "zip", "mp3", "wav", "m4a", "ogg", "mp4",
    "webm", "mov",
];

/// La ruta de una dirección `file://` (también `file://localhost/…`), o nada.
pub fn path_of(uri: &str) -> Option<PathBuf> {
    let rest = uri.trim().strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    Some(PathBuf::from(crate::media::percent_decode(rest)))
}

/// Si esa ruta (ya resuelta) es de un tipo que se adjunta.
pub fn allowed(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| ALLOWED.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Lee el fichero de una dirección `file://`, si es de lo que se adjunta.
pub fn read(uri: &str) -> Result<Vec<u8>, String> {
    let path = path_of(uri).ok_or("not-a-file-uri")?;
    let real = std::fs::canonicalize(&path).map_err(|_| "not-found".to_string())?;
    if !allowed(&real) {
        return Err("type-not-allowed".into());
    }
    let meta = std::fs::metadata(&real).map_err(|_| "not-found".to_string())?;
    if !meta.is_file() {
        return Err("not-a-file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("too-large".into());
    }
    std::fs::read(&real).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_path_of_a_file_uri() {
        assert_eq!(path_of("file:///home/rv/a%20b.png"), Some(PathBuf::from("/home/rv/a b.png")));
        assert_eq!(path_of("file://localhost/tmp/x.pdf"), Some(PathBuf::from("/tmp/x.pdf")));
        assert_eq!(path_of("https://x/y.png"), None);
        assert_eq!(path_of("file://otra-maquina/x.png"), None);
    }

    #[test]
    fn only_what_gets_attached() {
        for ok in ["/a/b.png", "/a/B.PDF", "/a/c.xlsx", "/a/v.mp4"] {
            assert!(allowed(Path::new(ok)), "{ok}");
        }
        for no in ["/home/rv/.ssh/id_rsa", "/a/.env", "/a/c.json", "/a/n.txt", "/a/sin"] {
            assert!(!allowed(Path::new(no)), "{no}");
        }
    }

    #[test]
    fn a_link_with_a_nice_name_to_a_key_does_not_pass() {
        let dir = std::env::temp_dir().join(format!("cac-drop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let llave = dir.join("id_rsa");
        std::fs::write(&llave, b"secreto").unwrap();
        let foto = dir.join("foto.png");
        let _ = std::fs::remove_file(&foto);
        std::os::unix::fs::symlink(&llave, &foto).unwrap();
        let uri = format!("file://{}", foto.display());
        assert_eq!(read(&uri), Err("type-not-allowed".to_string()));

        let png = dir.join("de-verdad.png");
        std::fs::write(&png, b"\x89PNG").unwrap();
        assert_eq!(read(&format!("file://{}", png.display())).unwrap(), b"\x89PNG");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Más que el tope de subida, no: el servidor lo rechazaría igual, después
    /// de haberlo leído entero a memoria.
    #[test]
    fn nothing_bigger_than_an_upload() {
        let dir = std::env::temp_dir().join(format!("cac-drop-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let grande = dir.join("grande.pdf");
        // Disperso: mide más del tope sin ocupar disco.
        std::fs::File::create(&grande).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert_eq!(read(&format!("file://{}", grande.display())), Err("too-large".to_string()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
