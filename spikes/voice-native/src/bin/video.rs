//! Spike del vídeo: los tres números que faltan para decidir cómo se pinta.
//!
//! El análisis de `docs/voz-video.md` deja la elección entre «codificar cada
//! trama y mandarla al webview» y «pintarla en una superficie nativa» a la
//! espera de datos. Esto los mide, en esta máquina y con estos crates, en vez
//! de razonarlos:
//!
//!   1. **¿Enlaza y captura el `DesktopCapturer` del propio libwebrtc?** Los
//!      símbolos de PipeWire están en el binario precompilado, pero eso no
//!      demuestra que el portal del escritorio conceda nada en Wayland.
//!   2. **¿Cuánto cuesta un JPEG?** Con el crate `image`, que la app ya tiene,
//!      a los tres tamaños que importan.
//!   3. **¿Cuánto cuesta la conversión de espacio de color?** Porque si el
//!      camino es mandar I420 crudo, esto no se paga; y si es JPEG, sí.
//!
//! Uso:  cargo run --bin video            (mide sin tocar la pantalla)
//!       cargo run --bin video -- captura (además, prueba el capturador)

use std::time::Instant;

/// Los tres tamaños que aparecen de verdad: un mosaico de la rejilla, una
/// pantalla compartida modesta, y la que promete el diseño.
const TAMANOS: &[(u32, u32, &str)] = &[
    (640, 360, "640x360   mosaico"),
    (1280, 720, "1280x720  pantalla modesta"),
    (1920, 1080, "1920x1080 lo que promete el diseño"),
];

/// Cuántas veces se repite cada medición. Suficiente para que el reloj no sea
/// el que manda, y poco para que el spike no tarde un café.
const VECES: u32 = 30;

fn main() {
    println!("== 2 y 3 · Coste por trama, crate `image` ==\n");
    println!(
        "{:<34} {:>10} {:>10} {:>9} {:>12}",
        "tamaño", "yuv→rgb", "jpeg q70", "fps jpeg", "kB por trama"
    );

    for &(w, h, etiqueta) in TAMANOS {
        let i420 = i420_de_prueba(w, h);
        let mut rgb = vec![0u8; (w * h * 3) as usize];

        let t = Instant::now();
        for _ in 0..VECES {
            i420_a_rgb(&i420, w, h, &mut rgb);
        }
        let ms_conv = t.elapsed().as_secs_f64() * 1000.0 / VECES as f64;

        let mut bytes = 0usize;
        let t = Instant::now();
        for _ in 0..VECES {
            bytes = jpeg(&rgb, w, h);
        }
        let ms_jpeg = t.elapsed().as_secs_f64() * 1000.0 / VECES as f64;

        let total = ms_conv + ms_jpeg;
        println!(
            "{:<34} {:>9.1}ms {:>9.1}ms {:>9.0} {:>12.0}",
            etiqueta,
            ms_conv,
            ms_jpeg,
            1000.0 / total,
            bytes as f64 / 1024.0
        );
    }

    println!("\n   «fps jpeg» es por trama y por persona, en un solo hilo: cuatro caras");
    println!("   a la vez cuestan cuatro veces esto.\n");
    println!("   Crudo por trama, para comparar con lo que cuesta el JPEG:");
    for &(w, h, etiqueta) in TAMANOS {
        let crudo = (w as f64 * h as f64 * 1.5) / 1024.0;
        println!("   {etiqueta:<34} {crudo:>8.0} kB  →  {:.1} MB/s a 30 fps", crudo * 30.0 / 1024.0);
    }

    println!("\n== 2 bis · Los otros dos codificadores ==\n");
    println!("   `image` es JPEG en Rust puro y sin vectorizar. Dos alternativas:");
    println!("   SIMD con la misma entrada RGB, y libjpeg-turbo comiendo el I420");
    println!("   **planar** tal cual — que se salta las dos conversiones de color.\n");
    println!(
        "{:<34} {:>13} {:>7} {:>13} {:>7} {:>9}",
        "tamaño", "simd (rgb)", "fps", "turbo (i420)", "fps", "kB"
    );
    for &(w, h, etiqueta) in TAMANOS {
        let i420 = i420_de_prueba(w, h);
        let mut rgb = vec![0u8; (w * h * 3) as usize];
        i420_a_rgb(&i420, w, h, &mut rgb);

        let t = Instant::now();
        for _ in 0..VECES {
            jpeg_simd(&rgb, w, h);
        }
        // Se le suma la conversión: con entrada RGB hay que pagarla igual.
        let ms_simd = t.elapsed().as_secs_f64() * 1000.0 / VECES as f64 + ms_conv_de(w, h, &i420);

        let mut bytes = 0usize;
        let t = Instant::now();
        for _ in 0..VECES {
            bytes = jpeg_turbo_planar(&i420, w, h);
        }
        let ms_turbo = t.elapsed().as_secs_f64() * 1000.0 / VECES as f64;

        println!(
            "{:<34} {:>12.1}ms {:>7.0} {:>12.1}ms {:>7.0} {:>9.0}",
            etiqueta, ms_simd, 1000.0 / ms_simd, ms_turbo, 1000.0 / ms_turbo,
            bytes as f64 / 1024.0
        );
    }

    if std::env::args().any(|a| a == "captura") {
        println!("\n== 1 · El capturador de escritorio ==\n");
        capturar();
    } else {
        println!("\n   (`cargo run --bin video -- captura` prueba además el capturador)");
    }
}

/// Una trama sintética con estructura: un degradado, no ruido.
///
/// Importa para el JPEG: el ruido aleatorio es el peor caso posible para
/// cualquier compresor y daría un tamaño que no se parece al de una cara.
fn i420_de_prueba(w: u32, h: u32) -> Vec<u8> {
    let (w, h) = (w as usize, h as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let mut v = vec![0u8; w * h + cw * ch * 2];
    for y in 0..h {
        for x in 0..w {
            v[y * w + x] = ((x * 255 / w) as u8).wrapping_add((y * 64 / h) as u8);
        }
    }
    for i in 0..cw * ch {
        v[w * h + i] = 110;
        v[w * h + cw * ch + i] = 140;
    }
    v
}

/// BT.601, la misma aritmética que `rgb_a_i420` de la app pero al revés.
fn i420_a_rgb(i420: &[u8], w: u32, h: u32, destino: &mut [u8]) {
    let (w, h) = (w as usize, h as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let (yp, resto) = i420.split_at(w * h);
    let (up, vp) = resto.split_at(cw * ch);
    for fila in 0..h {
        for col in 0..w {
            let y = yp[fila * w + col] as f32 - 16.0;
            let u = up[(fila / 2) * cw + col / 2] as f32 - 128.0;
            let v = vp[(fila / 2) * cw + col / 2] as f32 - 128.0;
            let i = (fila * w + col) * 3;
            destino[i] = (1.164 * y + 1.596 * v).clamp(0.0, 255.0) as u8;
            destino[i + 1] = (1.164 * y - 0.392 * u - 0.813 * v).clamp(0.0, 255.0) as u8;
            destino[i + 2] = (1.164 * y + 2.017 * u).clamp(0.0, 255.0) as u8;
        }
    }
}

fn jpeg(rgb: &[u8], w: u32, h: u32) -> usize {
    let mut salida = Vec::with_capacity(rgb.len() / 8);
    let mut cod = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut salida, 70);
    cod.encode(rgb, w, h, image::ExtendedColorType::Rgb8).expect("jpeg");
    salida.len()
}

/// El mismo JPEG con SIMD, misma entrada RGB que `image`.
fn jpeg_simd(rgb: &[u8], w: u32, h: u32) -> usize {
    use jpeg_encoder::{ColorType, Encoder};
    let mut salida = Vec::with_capacity(rgb.len() / 8);
    let cod = Encoder::new(&mut salida, 70);
    cod.encode(rgb, w as u16, h as u16, ColorType::Rgb).expect("jpeg simd");
    salida.len()
}

/// El camino corto: libjpeg-turbo comiendo los tres planos tal como llegan.
///
/// Es el único que puede, y por eso vale la pena la dependencia en C: el JPEG
/// **ya es YCbCr por dentro**, así que convertir a RGB para que el codificador
/// vuelva a convertir es trabajo que se paga dos veces por trama.
fn jpeg_turbo_planar(i420: &[u8], w: u32, h: u32) -> usize {
    let (w, h) = (w as usize, h as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let imagen = turbojpeg::YuvImage {
        pixels: i420,
        width: w,
        align: 1,
        height: h,
        subsamp: turbojpeg::Subsamp::Sub2x2,
    };
    debug_assert_eq!(i420.len(), w * h + cw * ch * 2);
    turbojpeg::compress_yuv(imagen, 70).expect("jpeg turbo").len()
}

/// La conversión sola, para poder sumársela a los que necesitan RGB.
fn ms_conv_de(w: u32, h: u32, i420: &[u8]) -> f64 {
    let mut rgb = vec![0u8; (w * h * 3) as usize];
    let t = Instant::now();
    for _ in 0..VECES {
        i420_a_rgb(i420, w, h, &mut rgb);
    }
    t.elapsed().as_secs_f64() * 1000.0 / VECES as f64
}

/// ¿Existe de verdad el capturador, enumera fuentes y entrega píxeles?
///
/// En Wayland esto pasa por xdg-desktop-portal, así que puede aparecer un
/// diálogo del sistema pidiendo permiso. Que aparezca **es** parte del
/// resultado: significa que el camino del portal está montado.
fn capturar() {
    use livekit::webrtc::desktop_capturer::{
        DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
    };

    let mut opciones = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
    opciones.set_include_cursor(true);
    let Some(mut cap) = DesktopCapturer::new(opciones) else {
        println!("   ✗ el capturador no se pudo crear (sin permisos o sin portal)");
        return;
    };
    let fuentes = cap.get_source_list();
    println!("   fuentes que enumera: {}", fuentes.len());
    for f in &fuentes {
        println!("     · id={} título={:?}", f.id(), f.title());
    }

    let (tx, rx) = std::sync::mpsc::channel();
    cap.start_capture(fuentes.first().cloned(), move |r| {
        let _ = tx.send(r.map(|f| (f.width(), f.height(), f.data().len())));
    });

    // Se pide trama en bucle y no una sola vez.
    //
    // En Wayland esto pasa por xdg-desktop-portal, que negocia de forma
    // asíncrona —y enseña su diálogo de permiso— mientras el capturador
    // contesta `Temporary`. Una sola llamada devuelve ese `Temporary` y parece
    // un fallo cuando lo que pasa es que todavía no ha contestado nadie.
    // Y se bombea el bucle de GLib entre intento e intento.
    //
    // Esto es lo que faltaba y no se ve venir: el capturador de PipeWire pide
    // la sesión al portal **por D-Bus con GIO**, y la respuesta llega como un
    // callback que sólo se despacha si alguien itera el contexto principal de
    // GLib. En un binario pelado no lo itera nadie, así que la petición sale,
    // la respuesta se queda en la cola, y `capture_frame` contesta `Temporary`
    // para siempre — 139 millones de veces en treinta segundos, medido.
    //
    // La app de Tauri tiene el bucle de GTK corriendo y no necesita esto. El
    // spike sí, y por eso lo enseña.
    extern "C" {
        fn g_main_context_iteration(context: *mut std::ffi::c_void, may_block: i32) -> i32;
    }

    let limite = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut temporales = 0u32;
    // A ritmo de vídeo, no a toda velocidad.
    //
    // La primera versión llamaba a `capture_frame` en bucle cerrado: 1,3
    // millones de veces por segundo, medido. Eso no es pedir tramas, es no
    // dejar trabajar al hilo de PipeWire que tiene que producirlas — el
    // capturador contesta `Temporary` mientras tanto y parece que el portal no
    // concedió nada. Un cliente de verdad pide a la tasa a la que va a pintar.
    // El `sleep` es explícito y no un `recv_timeout`.
    //
    // Con el plazo en el `recv` no se dormía nunca: el capturador contesta
    // `Temporary` **de forma síncrona** dentro de `capture_frame`, así que
    // siempre había un mensaje esperando, el `recv` volvía al instante y el
    // bucle seguía a un millón de vueltas por segundo. El plazo estaba puesto
    // donde no servía — que es como se escribe un límite que no limita.
    let cada = std::time::Duration::from_millis(1000 / 60);
    let mut ultimo_aviso = std::time::Instant::now();
    loop {
        // NULL = el contexto por defecto; 0 = no bloquear si no hay nada.
        unsafe {
            while g_main_context_iteration(std::ptr::null_mut(), 0) != 0 {}
        }
        cap.capture_frame();
        // Se vacía la cola: interesa el último resultado, no el primero.
        let mut ultimo = None;
        while let Ok(r) = rx.try_recv() {
            ultimo = Some(r);
        }
        match ultimo {
            Some(Ok((w, h, bytes))) => {
                println!("   ✓ trama capturada: {w}x{h}, {bytes} bytes");
                println!("     ({temporales} respuestas «Temporary» antes de la primera buena)");
                return;
            }
            Some(Err(livekit::webrtc::desktop_capturer::CaptureError::Permanent)) => {
                println!("   ✗ error permanente: el portal denegó o no hay backend");
                return;
            }
            Some(Err(_)) => temporales += 1,
            None => {}
        }
        std::thread::sleep(cada);
        if ultimo_aviso.elapsed() > std::time::Duration::from_secs(5) {
            ultimo_aviso = std::time::Instant::now();
            println!("   … esperando ({temporales} «Temporary», a 60 por segundo)");
        }
        if std::time::Instant::now() > limite {
            println!("   ✗ 30 s sin una sola trama ({temporales} «Temporary»)");
            println!("     Si no apareció diálogo del portal, falta xdg-desktop-portal");
            println!("     o su backend (…-gtk / …-hyprland / …-wlr) para este escritorio.");
            return;
        }
    }
}
