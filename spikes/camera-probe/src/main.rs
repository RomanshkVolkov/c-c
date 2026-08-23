//! Qué hace de verdad la webcam de esta máquina, con la misma biblioteca y las
//! mismas peticiones que la app.
//!
//! Reproduce la **cadena de formatos** de `arrancar_camara` —720p, 480p, la de
//! más fps, la mayor— y para cada una intenta sacar diez tramas, contando lo
//! que tarda cada una y el error exacto cuando falla. En la app eso mismo se
//! pierde: el bucle sale en silencio y el llamante sólo ve un plazo agotado.
//!
//!   cargo run

use std::time::{Duration, Instant};

use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{ApiBackend, CameraIndex, RequestedFormat, RequestedFormatType, Resolution};
use nokhwa::Camera;

/// Cuántas tramas se piden por intento. Diez bastan: si la primera llega, el
/// resto es confirmar que no fue casualidad.
const TRAMAS: usize = 10;

fn main() {
    println!("— qué cámaras ve nokhwa —");
    let camaras = nokhwa::query(ApiBackend::Auto).unwrap_or_default();
    for c in &camaras {
        // Cuántos formatos ofrece cada nodo: el que ofrece cero es el de
        // metadatos que acompaña a muchas webcams, y abrirlo no entrega nada.
        let formatos = Camera::new(
            c.index().clone(),
            RequestedFormat::new::<RgbFormat>(RequestedFormatType::None),
        )
        .and_then(|mut cam| cam.compatible_camera_formats())
        .map(|f| f.len())
        .unwrap_or(0);
        println!(
            "  index={:?}  nombre={:?}  formatos={}",
            c.index(),
            c.human_name(),
            formatos
        );
    }

    // Lo que ahora hace la app: quedarse sólo con las que ofrecen algún
    // formato. Es el arreglo, comprobado contra el hardware de verdad.
    let utiles: Vec<_> = camaras
        .iter()
        .filter(|c| {
            Camera::new(
                c.index().clone(),
                RequestedFormat::new::<RgbFormat>(RequestedFormatType::None),
            )
            .and_then(|mut cam| cam.compatible_camera_formats())
            .map(|f| !f.is_empty())
            .unwrap_or(false)
        })
        .collect();
    println!(
        "\n— tras filtrar las que no capturan: {} de {} —",
        utiles.len(),
        camaras.len()
    );
    for c in &utiles {
        println!("  se usaría {:?} ({:?})", c.index(), c.human_name());
    }

    let intentos: [(&str, RequestedFormatType); 4] = [
        ("720p", RequestedFormatType::HighestResolution(Resolution::new(1280, 720))),
        ("480p", RequestedFormatType::HighestResolution(Resolution::new(640, 480))),
        ("más fps", RequestedFormatType::AbsoluteHighestFrameRate),
        ("la mayor", RequestedFormatType::AbsoluteHighestResolution),
    ];

    for c in &camaras {
        println!("\n══ {:?} ({:?})", c.human_name(), c.index());
        for (nombre, tipo) in &intentos {
            probar(c.index().clone(), nombre, *tipo);
        }
    }

    // La secuencia **exacta** de la app, que es donde se cuelga: abrir y
    // cerrar todas para filtrarlas, y acto seguido abrir la buena y pedir
    // tramas. Se prueba porque el diario de la app enseña ese orden y luego
    // silencio, y el spike suelto no lo reproduce.
    println!("\n══ como lo hace la app: filtrar y abrir seguido ══");
    for vuelta in 1..=3 {
        let utiles: Vec<_> = nokhwa::query(ApiBackend::Auto)
            .unwrap_or_default()
            .into_iter()
            .filter(|c| {
                Camera::new(
                    c.index().clone(),
                    RequestedFormat::new::<RgbFormat>(RequestedFormatType::None),
                )
                .and_then(|mut cam| cam.compatible_camera_formats())
                .map(|f| !f.is_empty())
                .unwrap_or(false)
            })
            .collect();
        let Some(elegida) = utiles.first() else {
            println!("  vuelta {vuelta}: ninguna útil");
            continue;
        };
        print!("  vuelta {vuelta}: ");
        probar(
            elegida.index().clone(),
            "720p",
            RequestedFormatType::HighestResolution(Resolution::new(1280, 720)),
        );
    }
}

fn probar(indice: CameraIndex, nombre: &str, tipo: RequestedFormatType) {
    print!("  «{nombre}» → ");
    let mut cam = match Camera::new(indice, RequestedFormat::new::<RgbFormat>(tipo)) {
        Ok(c) => c,
        Err(e) => {
            println!("no abre: {e}");
            return;
        }
    };
    println!("abre como {}", cam.camera_format());

    let t = Instant::now();
    if let Err(e) = cam.open_stream() {
        println!("      open_stream falló tras {:?}: {e}", t.elapsed());
        return;
    }
    println!("      open_stream ok en {:?}", t.elapsed());

    let mut buenas = 0;
    for i in 0..TRAMAS {
        let t = Instant::now();
        match cam.frame() {
            Ok(trama) => {
                let bytes = trama.buffer().len();
                match trama.decode_image::<RgbFormat>() {
                    Ok(rgb) => {
                        buenas += 1;
                        // Sólo las dos primeras al detalle; el resto sería ruido.
                        if i < 2 {
                            println!(
                                "      trama {i}: {}x{} ({bytes} bytes crudos) en {:?}",
                                rgb.width(),
                                rgb.height(),
                                t.elapsed()
                            );
                        }
                    }
                    Err(e) => println!("      trama {i}: NO DECODIFICA tras {:?}: {e}", t.elapsed()),
                }
            }
            Err(e) => println!("      trama {i}: SIN TRAMA tras {:?}: {e}", t.elapsed()),
        }
        if t.elapsed() > Duration::from_secs(5) {
            println!("      (más de 5 s en una trama: se corta)");
            break;
        }
    }
    println!("      {buenas}/{TRAMAS} tramas buenas");
    let _ = cam.stop_stream();
}
