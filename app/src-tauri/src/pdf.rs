//! Comprimir un PDF en esta máquina, para la herramienta `compress_pdf` del MCP.
//!
//! Lo que pesa en un PDF casi siempre son las imágenes: un escaneo o una
//! captura a 300–600 ppp. Recomprimir los streams sin tocarlas (lo que haría
//! una biblioteca en Rust puro) apenas ahorra; lo que ahorra es volver a
//! muestrearlas a la resolución con la que se van a leer, y eso lo hace
//! Ghostscript (`pdfwrite` con `-dPDFSETTINGS`). No va dentro del binario: se
//! usa el `gs` del sistema si está, y si no, se dice cómo instalarlo.
//!
//! Se lanza con `host::command`, como todo programa del sistema: dentro de la
//! AppImage, un `gs` que heredara su entorno cargaría las bibliotecas de la
//! imagen.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// A qué resolución quedan las imágenes. Son los perfiles de Ghostscript.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Quality {
    /// 72 ppp: para leer en pantalla, lo más chico.
    Screen,
    /// 150 ppp: se lee bien y se imprime decente. El de por defecto.
    Ebook,
    /// 300 ppp: para imprimir; ahorra poco salvo en escaneos enormes.
    Printer,
}

impl Quality {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "screen" => Ok(Self::Screen),
            "ebook" => Ok(Self::Ebook),
            "printer" => Ok(Self::Printer),
            other => Err(format!("unknown quality `{other}`: use screen, ebook or printer")),
        }
    }

    fn setting(self) -> &'static str {
        match self {
            Self::Screen => "/screen",
            Self::Ebook => "/ebook",
            Self::Printer => "/printer",
        }
    }

    pub fn name(self) -> &'static str {
        &self.setting()[1..]
    }
}

/// Lo que pasó: o se escribió uno más chico, o el original ya estaba bien y no
/// se escribió nada (un PDF de texto puro suele salir igual o más grande).
#[derive(Debug, PartialEq)]
pub enum Outcome {
    Written { original_bytes: u64, bytes: u64 },
    NotSmaller { original_bytes: u64, result_bytes: u64 },
}

/// Un Ghostscript que se cuelga no puede colgar el MCP, que contesta de una en
/// una: pasado esto se mata. Un PDF de cientos de páginas escaneadas tarda
/// minutos, no decenas.
const TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Un PDF empieza por `%PDF-` (la norma deja basura antes, pero en el primer
/// KB). Se mira antes de lanzar nada: un `.pdf` que es otra cosa daría un
/// error de Ghostscript que no se entiende.
pub fn looks_like_pdf(head: &[u8]) -> bool {
    head.windows(5).take(1024).any(|w| w == b"%PDF-")
}

/// Dónde se escribe si no lo dicen: al lado, `informe.pdf` → `informe-compressed.pdf`.
pub fn default_out_path(input: &Path) -> PathBuf {
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "document".into());
    input.with_file_name(format!("{stem}-compressed.pdf"))
}

/// Los argumentos de `gs`. `-dSAFER` porque un PDF trae PostScript y no tiene
/// por qué leer ni escribir nada fuera de lo suyo; la salida va antes que la
/// entrada porque `gs` procesa los ficheros en orden.
pub fn gs_args(input: &Path, output: &Path, quality: Quality) -> Vec<OsString> {
    let mut out_arg = OsString::from("-sOutputFile=");
    out_arg.push(output);
    vec![
        "-dSAFER".into(),
        "-dBATCH".into(),
        "-dNOPAUSE".into(),
        "-dQUIET".into(),
        "-sDEVICE=pdfwrite".into(),
        "-dCompatibilityLevel=1.5".into(),
        format!("-dPDFSETTINGS={}", quality.setting()).into(),
        out_arg,
        input.as_os_str().to_owned(),
    ]
}

/// El ejecutable: `gswin64c` en Windows; en el resto `gs`, buscado también en
/// las carpetas de Homebrew, que no siempre están en el `PATH` de quien lanza
/// el MCP en un Mac.
fn find_gs() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["gswin64c", "gswin32c", "gs"] } else { &["gs"] };
    let extra: &[&str] = if cfg!(target_os = "macos") { &["/opt/homebrew/bin", "/usr/local/bin"] } else { &[] };
    for name in names {
        if crate::host::command(name).arg("--version").output().map(|o| o.status.success()).unwrap_or(false) {
            return Some(PathBuf::from(name));
        }
        for dir in extra {
            let p = Path::new(dir).join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "brew install ghostscript"
    } else if cfg!(windows) {
        "winget install ArtifexSoftware.GhostScript"
    } else {
        "install the `ghostscript` package (pacman -S ghostscript, apt install ghostscript)"
    }
}

/// Lo que se hace con el resultado: se queda sólo si es más chico.
pub fn decide(original_bytes: u64, result_bytes: u64) -> Outcome {
    if result_bytes > 0 && result_bytes < original_bytes {
        Outcome::Written { original_bytes, bytes: result_bytes }
    } else {
        Outcome::NotSmaller { original_bytes, result_bytes }
    }
}

/// Comprime `input` en `output`. Escribe primero a un fichero de al lado y lo
/// mueve sólo si salió más chico: a medias o más grande, `output` no se toca.
pub fn compress(input: &Path, output: &Path, quality: Quality) -> Result<Outcome, String> {
    if !input.is_absolute() || !output.is_absolute() {
        return Err("`path` and `outPath` have to be absolute".into());
    }
    let real_in = std::fs::canonicalize(input).map_err(|e| format!("{}: {e}", input.display()))?;
    // Que no pise el original: si sale mal a medias, se pierde el único que hay.
    if std::fs::canonicalize(output).map(|o| o == real_in).unwrap_or(false) {
        return Err("`outPath` is the original; write the compressed copy somewhere else".into());
    }
    let original_bytes = std::fs::metadata(&real_in).map_err(|e| format!("{}: {e}", input.display()))?.len();
    let head = {
        use std::io::Read;
        let mut buf = vec![0u8; 1024 + 5];
        let n = std::fs::File::open(&real_in)
            .and_then(|mut f| f.read(&mut buf))
            .map_err(|e| format!("{}: {e}", input.display()))?;
        buf.truncate(n);
        buf
    };
    if !looks_like_pdf(&head) {
        return Err(format!("{} is not a PDF", input.display()));
    }

    let gs = find_gs().ok_or_else(|| format!("Ghostscript is not installed on this machine: {}", install_hint()))?;
    let partial = output.with_extension("pdf.partial");
    let _ = std::fs::remove_file(&partial);

    let mut child = crate::host::command(&gs)
        .args(gs_args(&real_in, &partial, quality))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start Ghostscript: {e}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&partial);
                return Err(format!("Ghostscript took more than {} minutes; stopped", TIMEOUT.as_secs() / 60));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("waiting for Ghostscript: {e}")),
        }
    };
    if !status.success() {
        let mut err = String::new();
        if let Some(mut s) = child.stderr.take() {
            use std::io::Read;
            let _ = s.read_to_string(&mut err);
        }
        let _ = std::fs::remove_file(&partial);
        let err: String = err.trim().chars().take(600).collect();
        return Err(format!("Ghostscript could not rewrite the PDF ({status}): {err}"));
    }

    let result_bytes = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    let outcome = decide(original_bytes, result_bytes);
    match outcome {
        Outcome::Written { .. } => {
            std::fs::rename(&partial, output).map_err(|e| {
                let _ = std::fs::remove_file(&partial);
                format!("could not write {}: {e}", output.display())
            })?;
        }
        Outcome::NotSmaller { .. } => {
            let _ = std::fs::remove_file(&partial);
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rotura que detecta: quitar `-dSAFER` (el PostScript del PDF podría
    /// leer y escribir ficheros), cambiar el perfil que pide quien llama, o
    /// poner la entrada antes de la salida.
    #[test]
    fn ghostscript_gets_the_profile_and_runs_safe() {
        let a = gs_args(Path::new("/in/a.pdf"), Path::new("/out/b.pdf"), Quality::Screen);
        let a: Vec<String> = a.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(a.contains(&"-dSAFER".to_string()));
        assert!(a.contains(&"-sDEVICE=pdfwrite".to_string()));
        assert!(a.contains(&"-dPDFSETTINGS=/screen".to_string()));
        assert!(!a.iter().any(|x| x.contains("/ebook")));
        assert_eq!(a.last().unwrap(), "/in/a.pdf");
        assert!(a.contains(&"-sOutputFile=/out/b.pdf".to_string()));
        assert_eq!(Quality::parse("printer").unwrap().name(), "printer");
        assert!(Quality::parse("maximum").is_err());
    }

    /// Rotura que detecta: quedarse con un resultado igual o más grande (un
    /// PDF de texto suele crecer) o con uno vacío de un `gs` que no escribió.
    #[test]
    fn only_a_smaller_result_is_kept() {
        assert_eq!(decide(1000, 400), Outcome::Written { original_bytes: 1000, bytes: 400 });
        assert!(matches!(decide(1000, 1000), Outcome::NotSmaller { .. }));
        assert!(matches!(decide(1000, 1200), Outcome::NotSmaller { .. }));
        assert!(matches!(decide(1000, 0), Outcome::NotSmaller { .. }));
    }

    #[test]
    fn a_pdf_is_recognised_by_its_header() {
        assert!(looks_like_pdf(b"%PDF-1.7\n"));
        assert!(looks_like_pdf(b"\xef\xbb\xbf%PDF-1.4"));
        assert!(!looks_like_pdf(b"PK\x03\x04 a zip"));
        assert!(!looks_like_pdf(b""));
        assert_eq!(default_out_path(Path::new("/a/informe.pdf")), Path::new("/a/informe-compressed.pdf"));
    }

    /// Un PDF de una página con una imagen de 2000×2000 sin comprimir puesta
    /// en 200×200 pt: 720 ppp, 12 MB. Es lo que hace un escaneo.
    fn heavy_pdf() -> Vec<u8> {
        let (w, h) = (2000usize, 2000usize);
        let mut pixels = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                pixels.extend_from_slice(&[(x * 255 / w) as u8, (y * 255 / h) as u8, 128]);
            }
        }
        let mut out: Vec<u8> = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![];
        let objs: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>".to_vec(),
            {
                let c = b"q 200 0 0 200 0 0 cm /Im Do Q";
                let mut v = format!("<< /Length {} >>\nstream\n", c.len()).into_bytes();
                v.extend_from_slice(c);
                v.extend_from_slice(b"\nendstream");
                v
            },
            {
                let mut v = format!(
                    "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length {} >>\nstream\n",
                    pixels.len()
                )
                .into_bytes();
                v.extend_from_slice(&pixels);
                v.extend_from_slice(b"\nendstream");
                v
            },
        ];
        for (i, body) in objs.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).as_bytes());
        for o in offsets {
            out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).as_bytes());
        out
    }

    /// De punta a punta con el `gs` de la máquina (se salta si no hay): un
    /// escaneo pesado sale mucho más chico, y el original no se toca.
    /// Rotura que detecta: no escribir el resultado, escribirlo encima del
    /// original, o quedarse con el fichero `.partial`.
    #[test]
    fn a_heavy_scan_comes_out_smaller() {
        if find_gs().is_none() {
            eprintln!("sin Ghostscript: se salta");
            return;
        }
        let dir = std::env::temp_dir().join(format!("cac-pdf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("scan.pdf");
        let pdf = heavy_pdf();
        std::fs::write(&input, &pdf).unwrap();
        let output = default_out_path(&input);

        let got = compress(&input, &output, Quality::Ebook).unwrap();
        let Outcome::Written { original_bytes, bytes } = got else { panic!("{got:?}") };
        assert_eq!(original_bytes, pdf.len() as u64);
        assert!(bytes * 10 < original_bytes, "{bytes} de {original_bytes}");
        assert_eq!(std::fs::metadata(&output).unwrap().len(), bytes);
        assert!(looks_like_pdf(&std::fs::read(&output).unwrap()));
        assert_eq!(std::fs::read(&input).unwrap(), pdf);
        assert!(!output.with_extension("pdf.partial").exists());

        assert!(compress(&input, &input, Quality::Ebook).is_err());
        std::fs::write(dir.join("not.pdf"), b"hola").unwrap();
        assert!(compress(&dir.join("not.pdf"), &dir.join("x.pdf"), Quality::Ebook).unwrap_err().contains("not a PDF"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
