// ¿Cuánto cuesta una trama, y cuánto de eso es que el binario va sin optimizar?
//
// El camino caliente del auto-view: RGB de la cámara → I420 → JPEG para la
// ventana. Mismo código que la app, medido en los dos perfiles.
use std::time::Instant;

const W: usize = 1280;
const H: usize = 720;

fn rgb_a_i420(rgb: &[u8], w: usize, h: usize, y: &mut [u8], u: &mut [u8], v: &mut [u8]) {
    for fila in 0..h {
        for col in 0..w {
            let i = (fila * w + col) * 3;
            let (r, g, b) = (rgb[i] as f32, rgb[i + 1] as f32, rgb[i + 2] as f32);
            y[fila * w + col] = (0.257 * r + 0.504 * g + 0.098 * b + 16.0).clamp(0.0, 255.0) as u8;
        }
    }
    let cw = w / 2;
    for fila in (0..h).step_by(2) {
        for col in (0..w).step_by(2) {
            let i = (fila * w + col) * 3;
            let (r, g, b) = (rgb[i] as f32, rgb[i + 1] as f32, rgb[i + 2] as f32);
            u[(fila / 2) * cw + col / 2] =
                (-0.148 * r - 0.291 * g + 0.439 * b + 128.0).clamp(0.0, 255.0) as u8;
            v[(fila / 2) * cw + col / 2] =
                (0.439 * r - 0.368 * g - 0.071 * b + 128.0).clamp(0.0, 255.0) as u8;
        }
    }
}

fn jpeg(y: &[u8], u: &[u8], v: &[u8], w: usize, h: usize) -> usize {
    use jpeg_encoder::{ColorType, Encoder};
    let cw = w / 2;
    let mut entre = vec![0u8; w * h * 3];
    for fila in 0..h {
        let cf = (fila / 2) * cw;
        for col in 0..w {
            let d = (fila * w + col) * 3;
            entre[d] = y[fila * w + col];
            entre[d + 1] = u[cf + col / 2];
            entre[d + 2] = v[cf + col / 2];
        }
    }
    let mut salida = Vec::new();
    let mut e = Encoder::new(&mut salida, 70);
    e.set_sampling_factor(jpeg_encoder::SamplingFactor::F_2_2);
    e.encode(&entre, w as u16, h as u16, ColorType::Ycbcr).unwrap();
    salida.len()
}

// libjpeg-turbo come I420 planar directo: se salta el entrelazado entero.
fn jpeg_turbo(y: &[u8], u: &[u8], v: &[u8], w: usize, h: usize) -> usize {
    let img = turbojpeg::YuvImage {
        pixels: [y, u, v].concat(),
        width: w,
        align: 1,
        height: h,
        subsamp: turbojpeg::Subsamp::Sub2x2,
    };
    turbojpeg::compress_yuv(img.as_deref(), 70).unwrap().len()
}

fn medir(nombre: &str, vueltas: u32, mut f: impl FnMut()) {
    f();
    let t = Instant::now();
    for _ in 0..vueltas {
        f();
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0 / vueltas as f64;
    println!("  {nombre:22} {ms:7.2} ms/trama   → {:5.1} fps de techo", 1000.0 / ms);
}

fn main() {
    let perfil = if cfg!(debug_assertions) { "DEPURACIÓN" } else { "RELEASE" };
    println!("perfil: {perfil}  ({W}x{H})");
    let rgb: Vec<u8> = (0..W * H * 3).map(|i| (i % 251) as u8).collect();
    let (mut y, mut u, mut v) = (vec![0u8; W * H], vec![0u8; W * H / 4], vec![0u8; W * H / 4]);

    medir("rgb→i420", 80, || rgb_a_i420(&rgb, W, H, &mut y, &mut u, &mut v));
    rgb_a_i420(&rgb, W, H, &mut y, &mut u, &mut v);
    medir("i420→jpeg (actual)", 80, || {
        jpeg(&y, &u, &v, W, H);
    });
    medir("i420→jpeg (turbo)", 80, || {
        jpeg_turbo(&y, &u, &v, W, H);
    });
}
