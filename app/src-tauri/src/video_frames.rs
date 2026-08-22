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
//!
//! **Dos cosas que costaron una app colgada** (v1.6.38, la primera con vídeo):
//!
//!  1. El manejador era **síncrono**, así que comprimía en el hilo que atiende
//!     al webview — el bucle principal de la interfaz. Once milisegundos de
//!     JPEG por trama, decenas de veces por segundo, y la ventana deja de
//!     responder. Ahora la petición se contesta desde otro hilo.
//!  2. Se recomprimía **la misma trama** una y otra vez si la pantalla pedía
//!     más deprisa de lo que llegaban. Cada trama lleva ahora un número de
//!     secuencia; quien ya la tiene recibe un 204 y no se comprime nada.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::http::{Request, Response};

/// De qué es una trama: de una cara o de una pantalla.
///
/// Las dos cosas se guardan por separado y no es un detalle: una persona puede
/// publicar las dos a la vez, y con una sola entrada por participante la
/// segunda pisaba a la primera — el mosaico habría parpadeado entre la cara y
/// la pantalla treinta veces por segundo.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Fuente {
    Camara,
    Pantalla,
}

impl Fuente {
    /// El nombre con el que viaja en la URL y hasta la interfaz.
    pub fn como_texto(self) -> &'static str {
        match self {
            Fuente::Camara => "camera",
            Fuente::Pantalla => "screen",
        }
    }

    fn de_texto(t: &str) -> Option<Self> {
        match t {
            "camera" => Some(Fuente::Camara),
            "screen" => Some(Fuente::Pantalla),
            _ => None,
        }
    }
}

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
#[derive(Clone)]
struct Cruda {
    /// Cuál es. Sube uno por trama recibida, y es lo que permite contestar
    /// «no ha cambiado» sin volver a comprimir.
    seq: u64,
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
static ULTIMAS: LazyLock<Mutex<HashMap<(String, Fuente), Cruda>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Guarda lo que acaba de llegar de esta persona.
pub fn guardar(
    identidad: &str,
    fuente: Fuente,
    i420: &livekit::webrtc::prelude::I420Buffer,
    ancho: u32,
    alto: u32,
) {
    let (sy, su, sv) = i420.strides();
    let (yp, up, vp) = i420.data();

    let planos = empaquetar((yp, up, vp), (sy, su, sv), ancho, alto);

    let clave = (identidad.to_string(), fuente);
    let mut guard = ULTIMAS.lock().unwrap();
    let seq = guard.get(&clave).map_or(1, |c| c.seq + 1);
    guard.insert(clave, Cruda { seq, ancho, alto, planos });
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

/// Esta persona dejó de publicar esto.
pub fn olvidar(identidad: &str, fuente: Fuente) {
    ULTIMAS.lock().unwrap().remove(&(identidad.to_string(), fuente));
}

/// Esta persona se fue: se va todo lo suyo, publicara lo que publicara.
pub fn olvidar_persona(identidad: &str) {
    ULTIMAS.lock().unwrap().retain(|(quien, _), _| quien != identidad);
}

/// Al salir de la sala. Sin esto, entrar a otra enseñaría durante un instante
/// la última cara de la anterior.
pub fn olvidar_todo() {
    ULTIMAS.lock().unwrap().clear();
}

/// Quién y qué pide una URL `cacvideo://…/<identidad>/<fuente>`.
///
/// Los sistemas no se ponen de acuerdo en la forma —`cacvideo://localhost/…`
/// en Linux y macOS, `http://cacvideo.localhost/…` en Windows— así que se
/// normalizan las dos. La cola `?seq=` se descarta aquí.
///
/// Sin fuente en el camino se asume la cámara. No es por compatibilidad: es que
/// una URL a medias tiene que resolver a algo concreto, y la cara es lo que
/// pide un mosaico normal.
pub fn pedido_de(uri: &str) -> Option<(String, Fuente)> {
    let tras_esquema = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
    let camino = tras_esquema.split_once('/').map(|(_, p)| p)?;
    let camino = camino.split('?').next().unwrap_or(camino);
    let mut partes = camino.trim_matches('/').split('/');
    let id = partes.next().unwrap_or("");
    if id.is_empty() {
        return None;
    }
    let fuente = partes.next().and_then(Fuente::de_texto).unwrap_or(Fuente::Camara);
    Some((id.to_string(), fuente))
}

/// El número de trama que el webview dice tener ya, de `?seq=`.
fn seq_pedida(uri: &str) -> Option<u64> {
    uri.split_once("seq=")
        .map(|(_, r)| r.split('&').next().unwrap_or(r))
        .and_then(|v| v.parse().ok())
}

/// Contesta a `cacvideo://localhost/<identidad>/<fuente>?seq=<la que ya tengo>`.
///
/// **Se llama desde un hilo aparte**, nunca desde el bucle de la interfaz: ver
/// la nota de arriba sobre la app colgada.
pub fn servir(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = req.uri().to_string();
    let Some((id, fuente)) = pedido_de(&uri) else {
        return vacia(400);
    };

    // El bloqueo se suelta **antes** de comprimir. Comprimir con el candado
    // puesto para el hilo que además está guardando las tramas que llegan es
    // cómo se para la recepción entera por pintar una imagen.
    let trama = {
        let guard = ULTIMAS.lock().unwrap();
        guard.get(&(id, fuente)).cloned()
    };
    let Some(t) = trama else {
        // 404 y no una imagen en blanco: «todavía no hay trama» es un estado
        // que la interfaz tiene que poder distinguir de «hay una trama negra».
        return vacia(404);
    };
    // Ya tiene ésta. Contestar 204 cuesta nada; comprimirla otra vez para que
    // pinte lo mismo cuesta once milisegundos de CPU por cada vez que pregunta.
    if seq_pedida(&uri) == Some(t.seq) {
        return vacia(204);
    }
    let Some(jpeg) = comprimir(&t.planos, t.ancho, t.alto) else {
        return vacia(500);
    };

    Response::builder()
        .status(200)
        .header("Content-Type", "image/jpeg")
        // Para que la pantalla sepa qué acaba de recibir y pueda no volver a
        // pedirlo.
        .header("X-Cac-Seq", t.seq.to_string())
        .header("Access-Control-Expose-Headers", "X-Cac-Seq")
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
    use super::{comprimir, empaquetar, pedido_de, Fuente};

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

    // Las formas que toma la misma petición según el sistema, más la cola que
    // el frontend añade para saltarse la caché.
    #[test]
    fn saca_quien_y_que_de_cualquiera_de_las_formas() {
        let camara = Some(("u-bea".to_string(), Fuente::Camara));
        assert_eq!(pedido_de("cacvideo://localhost/u-bea/camera"), camara);
        assert_eq!(pedido_de("http://cacvideo.localhost/u-bea/camera"), camara);
        assert_eq!(pedido_de("cacvideo://localhost/u-bea/camera?seq=7"), camara);
        assert_eq!(
            pedido_de("cacvideo://localhost/u-bea/screen?seq=7"),
            Some(("u-bea".to_string(), Fuente::Pantalla))
        );
    }

    // La cara y la pantalla de la misma persona son dos cosas distintas y se
    // piden por separado. Con una sola entrada por participante, quien
    // compartiera pantalla con la cámara encendida haría parpadear su mosaico
    // entre las dos treinta veces por segundo.
    #[test]
    fn la_camara_y_la_pantalla_no_son_lo_mismo() {
        assert_ne!(
            pedido_de("cacvideo://localhost/u-bea/camera"),
            pedido_de("cacvideo://localhost/u-bea/screen")
        );
    }

    // Sin fuente, la cara: una URL a medias tiene que resolver a algo concreto.
    #[test]
    fn sin_fuente_se_asume_la_camara() {
        assert_eq!(
            pedido_de("cacvideo://localhost/u-bea"),
            Some(("u-bea".to_string(), Fuente::Camara))
        );
    }

    // Sin identidad no hay a quién servir, y devolver la primera trama que haya
    // sería enseñarle a alguien la cara de otro.
    #[test]
    fn sin_identidad_no_contesta() {
        assert_eq!(pedido_de("cacvideo://localhost/"), None);
        assert_eq!(pedido_de("cacvideo://localhost"), None);
    }
}
