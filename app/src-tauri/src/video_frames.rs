//! Las caras y las pantallas de los demás, servidas al webview.
//!
//! **El problema que resuelve.** El motor de voz vive en Rust —el webview de
//! Linux no tiene WebRTC, ver `docs/voz.md`— y la interfaz vive en el webview.
//! Las tramas de vídeo llegan al proceso nativo y hay que cruzar esa frontera
//! treinta veces por segundo. El audio nunca lo tuvo: sale por los altavoces
//! sin pasar por la ventana.
//!
//! **La decisión, con números.** Mandar el I420 crudo son 89 MB/s por una
//! pantalla 1080p30. Comprimir a JPEG lo baja a ~1,3 MB/s a cambio de CPU, y
//! ese cambio sale a cuenta: el transporte es la parte de la que no tenemos
//! medida y la CPU sí. Todo en `docs/voz-video.md` §3.
//!
//! **Y se codifica cuando lo piden, no cuando llega.** Aquí sólo se guarda la
//! última trama cruda de cada participante; el JPEG se hace en el momento en
//! que el webview pide la imagen. Así una cámara encendida cuyo mosaico no se
//! está mirando —minimizado, en otra pantalla— no cuesta un solo ciclo, y el
//! ritmo lo marca lo que la interfaz es capaz de pintar en vez de lo que la red
//! es capaz de entregar.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::http::{Request, Response};

/// El esquema que usa el webview. La interfaz construye la URL correcta para
/// cada sistema con `convertFileSrc(identidad, "cacvideo")`.
pub const SCHEME: &str = "cacvideo";

/// Calidad del JPEG.
///
/// 70 y no 90: en una cara a 640×360 la diferencia no se ve y el archivo es la
/// mitad. En una pantalla compartida con texto pequeño sí se notaría, y ése es
/// el sitio donde habrá que volver si alguien se queja de que no lee el código.
const CALIDAD: u8 = 70;

/// Una trama tal como la entregó el motor, sin comprimir.
struct Cruda {
    ancho: u32,
    alto: u32,
    /// Los tres planos, ya contiguos y sin relleno entre filas.
    ///
    /// Se copian aquí en vez de guardar el búfer del SDK porque ése se
    /// reutiliza: quedarse con la referencia significaría servir una trama que
    /// ya se sobrescribió, y eso se ve como rayas.
    planos: Vec<u8>,
}

/// La última trama de cada participante. Sólo la última: si el webview va más
/// lento que la red, lo correcto es saltarse tramas y enseñar lo más reciente,
/// no acumular una cola que se va convirtiendo en retraso.
static ULTIMAS: LazyLock<Mutex<HashMap<String, Cruda>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Guarda lo que acaba de llegar de esta persona.
pub fn guardar(
    identidad: &str,
    i420: &livekit::webrtc::prelude::I420Buffer,
    ancho: u32,
    alto: u32,
) {
    let (sy, su, sv) = i420.strides();
    let (yp, up, vp) = i420.data();

    let planos = empaquetar((yp, up, vp), (sy, su, sv), ancho, alto);

    ULTIMAS
        .lock()
        .unwrap()
        .insert(identidad.to_string(), Cruda { ancho, alto, planos });
}

/// Quita el relleno del final de cada fila y deja los tres planos pegados.
///
/// Los planos del SDK vienen con un *stride* mayor que el ancho —relleno para
/// alinear cada fila en memoria— y el codificador espera filas contiguas.
/// Pasarle los bytes tal cual produce la imagen **inclinada**, que es el
/// aspecto inconfundible de haber ignorado un stride, y no falla de ninguna
/// otra forma: no revienta, no avisa, sólo sale torcida.
fn empaquetar(
    (yp, up, vp): (&[u8], &[u8], &[u8]),
    (sy, su, sv): (u32, u32, u32),
    ancho: u32,
    alto: u32,
) -> Vec<u8> {
    let (w, h) = (ancho as usize, alto as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let mut fuera = Vec::with_capacity(w * h + cw * ch * 2);
    for fila in 0..h {
        let i = fila * sy as usize;
        fuera.extend_from_slice(&yp[i..i + w]);
    }
    for (plano, stride) in [(up, su), (vp, sv)] {
        for fila in 0..ch {
            let i = fila * stride as usize;
            fuera.extend_from_slice(&plano[i..i + cw]);
        }
    }
    fuera
}

/// Esta persona dejó de publicar vídeo.
pub fn olvidar(identidad: &str) {
    ULTIMAS.lock().unwrap().remove(identidad);
}

/// Al salir de la sala. Sin esto, entrar a otra enseñaría durante un instante
/// la última cara de la anterior.
pub fn olvidar_todo() {
    ULTIMAS.lock().unwrap().clear();
}

/// La identidad que pide una URL `cacvideo://…`.
///
/// Los sistemas no se ponen de acuerdo en la forma —`cacvideo://localhost/<id>`
/// en Linux y macOS, `http://cacvideo.localhost/<id>` en Windows— así que se
/// normalizan las dos. La cola `?t=` que el frontend añade para que nadie
/// cachee se descarta aquí.
pub fn identidad_de(uri: &str) -> Option<String> {
    let tras_esquema = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
    let camino = tras_esquema.split_once('/').map(|(_, p)| p)?;
    let camino = camino.split('?').next().unwrap_or(camino);
    let id = camino.trim_matches('/');
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

/// Contesta a `cacvideo://localhost/<identidad>` con la última trama en JPEG.
pub fn servir(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(id) = identidad_de(req.uri().to_string().as_str()) else {
        return vacia(400);
    };

    let guard = ULTIMAS.lock().unwrap();
    let Some(t) = guard.get(&id) else {
        // 404 y no una imagen en blanco: «todavía no hay trama» es un estado
        // que la interfaz tiene que poder distinguir de «hay una trama negra».
        return vacia(404);
    };
    let Some(jpeg) = comprimir(&t.planos, t.ancho, t.alto) else {
        return vacia(500);
    };
    drop(guard);

    Response::builder()
        .status(200)
        .header("Content-Type", "image/jpeg")
        // Sin caché: la URL es la misma trama tras trama y un `304` congelaría
        // la imagen para siempre.
        .header("Cache-Control", "no-store")
        // En Windows el esquema se sirve como `http://cacvideo.localhost`, que
        // es otro origen, y un `fetch` desde la interfaz se bloquearía sin
        // esto. Los adjuntos no lo necesitan porque los consume un `<img>`, que
        // no pregunta. Abrir esto no expone nada: el esquema sólo existe dentro
        // de nuestro propio webview.
        .header("Access-Control-Allow-Origin", "*")
        .body(jpeg)
        .unwrap_or_else(|_| vacia(500))
}

/// I420 planar → JPEG.
///
/// **Éste es el renglón que se cambia si hace falta más velocidad.**
/// `jpeg-encoder` es Rust puro con SIMD y no pide nada al sistema, pero sólo
/// come YCbCr **entrelazado**, así que hay que reordenar antes. libjpeg-turbo
/// comería los planos tal cual y tardaría seis veces menos; a cambio quiere
/// `cmake` y `nasm` en los tres sistemas de compilación. Los números de los dos
/// están en `docs/voz-video.md` §3, para que la decisión se pueda rehacer con
/// datos en vez de con memoria.
///
/// El reordenado **no tiene aritmética de color**: son los mismos valores en
/// otro orden, con el croma duplicado. Lo caro sería convertir a RGB para que
/// el codificador volviera a convertir a YCbCr, y eso es justo lo que se evita.
fn comprimir(planos: &[u8], ancho: u32, alto: u32) -> Option<Vec<u8>> {
    use jpeg_encoder::{ColorType, Encoder};
    let (w, h) = (ancho as usize, alto as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    if planos.len() < w * h + cw * ch * 2 {
        return None;
    }
    let (yp, resto) = planos.split_at(w * h);
    let (up, vp) = resto.split_at(cw * ch);

    let mut entrelazado = vec![0u8; w * h * 3];
    for fila in 0..h {
        let cfila = (fila / 2) * cw;
        for col in 0..w {
            let i = (fila * w + col) * 3;
            entrelazado[i] = yp[fila * w + col];
            entrelazado[i + 1] = up[cfila + col / 2];
            entrelazado[i + 2] = vp[cfila + col / 2];
        }
    }

    let mut salida = Vec::with_capacity(planos.len() / 8);
    Encoder::new(&mut salida, CALIDAD)
        .encode(&entrelazado, ancho as u16, alto as u16, ColorType::Ycbcr)
        .ok()?;
    Some(salida)
}

fn vacia(codigo: u16) -> Response<Vec<u8>> {
    Response::builder().status(codigo).body(Vec::new()).unwrap()
}

#[cfg(test)]
mod pruebas {
    use super::{comprimir, empaquetar, identidad_de};

    /// Una trama de 4×4 con **relleno al final de cada fila**, que es la forma
    /// en que llegan las de verdad.
    ///
    /// 4×4 y no 4×2 a propósito: con dos filas el croma tiene una sola y su
    /// stride no llega a usarse nunca, así que un test sobre esa trama pasa
    /// aunque el croma se lea mal. Costó descubrirlo mutando.
    fn con_relleno() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        // Luma: 4 filas de 4 útiles + 2 de relleno (stride 6).
        let mut y = Vec::new();
        for fila in 0..4u8 {
            y.extend_from_slice(&[fila * 4 + 1, fila * 4 + 2, fila * 4 + 3, fila * 4 + 4, 9, 9]);
        }
        // Croma: 2 filas de 2 útiles + 2 de relleno (stride 4).
        let u = vec![10, 11, 9, 9, 12, 13, 9, 9];
        let v = vec![20, 21, 9, 9, 22, 23, 9, 9];
        (y, u, v)
    }

    // El 9 es el relleno. Si aparece en la salida, alguien tomó el stride por
    // el ancho — y la imagen sale inclinada sin que nada falle ni avise.
    #[test]
    fn el_relleno_de_cada_fila_se_queda_fuera() {
        let (y, u, v) = con_relleno();
        let salida = empaquetar((&y, &u, &v), (6, 4, 4), 4, 4);
        assert_eq!(
            salida,
            vec![
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, // luma
                10, 11, 12, 13, // u
                20, 21, 22, 23, // v
            ]
        );
    }

    // Y con stride igual al ancho —que también pasa— no se pierde nada.
    #[test]
    fn sin_relleno_no_recorta_de_mas() {
        let y: Vec<u8> = (1..=16).collect();
        let (u, v) = (vec![10, 11, 12, 13], vec![20, 21, 22, 23]);
        let salida = empaquetar((&y, &u, &v), (4, 2, 2), 4, 4);
        assert_eq!(salida, [y.as_slice(), &u, &v].concat());
    }

    // El JPEG que sale tiene que ser un JPEG. Se comprueba la firma y no el
    // contenido: comparar píxeles de una compresión con pérdida es un test que
    // se rompe cada vez que alguien toca la calidad.
    #[test]
    fn comprime_a_algo_que_es_un_jpeg() {
        let planos = vec![128u8; 16 * 16 + 8 * 8 * 2];
        let jpeg = comprimir(&planos, 16, 16).expect("tiene que comprimir");
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "todo JPEG empieza por SOI");
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9], "y termina en EOI");
    }

    // Unos planos más cortos de lo que dicen las medidas no pueden reventar el
    // proceso: llegan del otro lado de una frontera y hay que tratarlos como
    // datos, no como una promesa.
    #[test]
    fn unos_planos_truncados_no_tumban_nada() {
        assert!(comprimir(&[0u8; 10], 640, 360).is_none());
    }

    // Las tres formas que toma la misma petición según el sistema, más la cola
    // que el frontend añade para saltarse la caché.
    #[test]
    fn saca_la_identidad_de_cualquiera_de_las_formas() {
        assert_eq!(identidad_de("cacvideo://localhost/u-bea").as_deref(), Some("u-bea"));
        assert_eq!(identidad_de("http://cacvideo.localhost/u-bea").as_deref(), Some("u-bea"));
        assert_eq!(identidad_de("cacvideo://localhost/u-bea?t=12345").as_deref(), Some("u-bea"));
    }

    // Sin identidad no hay a quién servir, y devolver la primera trama que haya
    // sería enseñarle a alguien la cara de otro.
    #[test]
    fn sin_identidad_no_contesta() {
        assert_eq!(identidad_de("cacvideo://localhost/"), None);
        assert_eq!(identidad_de("cacvideo://localhost"), None);
    }
}
