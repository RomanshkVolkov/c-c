//! Bajar un fichero de una URL firmada (un backup en S3) a donde diga quien lo
//! pide, contando por dónde va.
//!
//! Hasta la v1.23.0 la app abría la URL con `window.open`, y el webview del
//! escritorio no abre ventanas nuevas: el clic no hacía nada, sin error, sin
//! diálogo y sin progreso (jose, 24-oct-2026, con un backup de boaty).
//!
//! Va a un `.part` y se renombra al acabar, como las grabaciones: un corte a
//! mitad no deja algo que parece el backup y no lo es. Por trozos: un backup
//! de gigas no pasa por memoria.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::Emitter;

/// Cada cuánto se cuenta el progreso a la ventana.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    done: u64,
    total: Option<u64>,
}

/// Sólo HTTPS: la URL la da el backend, pero esto escribe en el disco de quien
/// la abre y no tiene por qué bajar de cualquier sitio.
fn allowed_url(url: &str) -> bool {
    url.starts_with("https://")
}

/// `backup.age` → `backup.age.part`, al lado.
fn part_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    target.with_file_name(name)
}

/// Baja `url` a `target` por trozos, contando lo bajado a `progress`. Si algo
/// falla, no deja nada: ni el `.part` ni el fichero.
async fn fetch_to(url: &str, target: &Path, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(), String> {
    let mut res = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not download: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("The storage answered {}: the link may have expired, ask for it again", res.status().as_u16()));
    }
    let total = res.content_length();
    let part = part_path(target);
    let result = async {
        let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut done = 0u64;
        let mut last = Instant::now();
        progress(0, total);
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            f.write_all(&chunk).map_err(|e| e.to_string())?;
            done += chunk.len() as u64;
            if last.elapsed() >= PROGRESS_EVERY {
                progress(done, total);
                last = Instant::now();
            }
        }
        f.flush().map_err(|e| e.to_string())?;
        // Segunda red: hyper ya da error si la conexión se corta antes del
        // `Content-Length`, así que quitarla no rompe ninguna prueba (mutante
        // equivalente, comprobado con /mutar). Se queda por si un día el
        // cliente deja de hacerlo: un backup corto no se abre.
        if let Some(t) = total {
            if done != t {
                return Err(format!("the download stopped at {done} of {t} bytes"));
            }
        }
        progress(done, total);
        std::fs::rename(&part, target).map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = result {
        let _ = std::fs::remove_file(&part);
        return Err(format!("Could not save the file: {e}"));
    }
    Ok(())
}

/// Pregunta dónde guardar y baja ahí. `None` si se cancela el diálogo, para
/// que la app calle en vez de contarlo como un fallo. El progreso llega como
/// `download://progress` con el `id` que se pasó.
#[tauri::command]
pub async fn download_to_file(app: tauri::AppHandle, id: String, url: String, file_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    if !allowed_url(&url) {
        return Err("Only https links can be downloaded".into());
    }
    let mut dialog = app.dialog().file().set_file_name(&file_name);
    if let Some(dir) = crate::dialog_dir(&app) {
        dialog = dialog.set_directory(dir);
    }
    let Some(chosen) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let target = chosen.into_path().map_err(|e| e.to_string())?;
    crate::remember_dialog_dir(target.parent());

    fetch_to(&url, &target, |done, total| {
        let _ = app.emit("download://progress", Progress { id: id.clone(), done, total });
    })
    .await?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Un servidor de una sola respuesta: lo que conteste `answer`.
    fn serve_once(answer: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let _ = s.write_all(&answer);
            }
        });
        format!("http://{addr}/obj")
    }

    /// Una carpeta vacía para la prueba, que se borra al acabar.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("cac-download-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn ok(body: &[u8]) -> Vec<u8> {
        let mut r = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        r.extend_from_slice(body);
        r
    }

    /// Baja entero, cuenta hasta el total, y no deja el `.part`. Roturas que
    /// atrapa: no renombrar el `.part`; no contar el final.
    #[tokio::test]
    async fn a_download_lands_whole_and_counts_to_the_end() {
        let body = vec![7u8; 300_000];
        let url = serve_once(ok(&body));
        let dir = TempDir::new("whole");
        let target = dir.path().join("boaty.age");
        let mut seen = Vec::new();
        fetch_to(&url, &target, |d, t| seen.push((d, t))).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), body);
        assert!(!part_path(&target).exists());
        assert_eq!(seen.last(), Some(&(300_000, Some(300_000))));
    }

    /// Un enlace caducado (S3 contesta 403) o una descarga cortada no dejan
    /// nada en la carpeta, ni a medias. Roturas que atrapa: escribir el cuerpo
    /// del error como si fuera el backup; dejar el `.part` o un fichero corto.
    #[tokio::test]
    async fn a_failed_download_leaves_nothing_behind() {
        let dir = TempDir::new("failed");
        let target = dir.path().join("boaty.age");
        let url = serve_once(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 13\r\nConnection: close\r\n\r\nAccessDenied.".to_vec());
        let err = fetch_to(&url, &target, |_, _| {}).await.unwrap_err();
        assert!(err.contains("403"), "{err}");

        let mut short = b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n".to_vec();
        short.extend_from_slice(&[1u8; 10]);
        let url = serve_once(short);
        assert!(fetch_to(&url, &target, |_, _| {}).await.is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "quedó algo en la carpeta");
    }

    #[test]
    fn only_https_links_are_downloaded() {
        assert!(allowed_url("https://guz-db-backups.s3.us-east-1.amazonaws.com/x?X-Amz-Signature=1"));
        assert!(!allowed_url("http://example.com/x"));
        assert!(!allowed_url("file:///etc/passwd"));
    }
}
