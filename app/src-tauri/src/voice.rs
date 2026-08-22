//! Los canales de voz, con el motor dentro del proceso y no en el webview.
//!
//! **Por qué nativo.** El plan natural era `livekit-client` en el webview, y en
//! Windows y macOS habría bastado. En Linux no: el WebKitGTK de Arch viene
//! *compilado* sin WebRTC — cero símbolos de `JSRTCPeerConnection` en la
//! biblioteca del sistema, y la propiedad `enable-webrtc` es una puerta sin
//! habitación detrás. No es configurable. Se midió antes de decidir, y el acta
//! está en `docs/voz.md`.
//!
//! Se descartó a propósito abrir la sala en el navegador: manda la conversación
//! fuera de la app justo cuando la tesis de cac es que el trabajo viva dentro.
//! Y el motor va nativo en los **tres** sistemas, no sólo en Linux: dos stacks
//! de media serían dos superficies de bugs para el mismo problema.
//!
//! **Qué autoriza qué.** Aquí no hay credenciales de cac. La pantalla pide el
//! token al backend —que comprueba la pertenencia a la organización y deriva la
//! sala del espacio— y le pasa a este módulo un `{url, token}` ya concedido.
//! Este código no puede entrar donde no le dejaron entrar.

use std::sync::{Arc, LazyLock, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use livekit::options::TrackPublishOptions;
use livekit::track::{LocalAudioTrack, LocalTrack, LocalVideoTrack, RemoteTrack, TrackSource};
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::{AudioFrame, I420Buffer, VideoFrame, VideoResolution, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::RtcVideoSource;
use livekit::{Room, RoomEvent, RoomOptions};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_stream::StreamExt;

/// 48 kHz mono: lo que WebRTC usa internamente. Publicar en su tasa evita un
/// remuestreo que sólo añadiría latencia y una cosa más que puede sonar mal.
const SAMPLE_RATE: u32 = 48_000;
const CANALES: u32 = 1;
/// 10 ms por trama, que es el tamaño que espera libwebrtc.
const MUESTRAS_POR_TRAMA: usize = SAMPLE_RATE as usize / 100;

/// Lo que la sala le cuenta a la pantalla.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoiceEvent {
    /// Dentro. `identity` es el id de usuario de cac — el mismo que acuñó el
    /// token, así que la pantalla puede cruzarlo con la gente que ya conoce.
    Connected { identity: String },
    Joined { identity: String, name: String },
    Left { identity: String },
    /// Quién está hablando ahora mismo. Llega la lista entera y no un delta:
    /// reconstruir el conjunto a base de altas y bajas es cómo se acaba con un
    /// punto verde encendido para siempre por un evento perdido.
    Speaking { identities: Vec<String> },
    Disconnected { reason: String },
}

struct VoiceSession {
    room: Arc<Room>,
    /// Se retienen para que la captura siga viva: soltar el stream de cpal lo
    /// para, y soltar la fuente corta lo que se publica.
    _captura: StreamGuard,
    fuente: NativeAudioSource,
}

/// Un `cpal::Stream` no es `Send`, y aquí hace falta guardarlo en una estructura
/// compartida entre hilos. Vive en su propio hilo con un canal para matarlo, que
/// es la forma honesta de cumplir las dos cosas a la vez.
struct StreamGuard(Option<std::sync::mpsc::Sender<()>>);

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

static SESION: LazyLock<Mutex<Option<VoiceSession>>> = LazyLock::new(|| Mutex::new(None));

/// Entrar a una sala. Una a la vez: estar en dos conversaciones de voz al mismo
/// tiempo no es algo que nadie quiera, y permitirlo sería mezclar dos micrófonos
/// abiertos sin que se note cuál es cuál.
#[tauri::command]
pub async fn voice_join(
    url: String,
    token: String,
    on_event: Channel<VoiceEvent>,
) -> Result<String, String> {
    voice_leave().await;

    let (room, eventos) = Room::connect(&url, &token, RoomOptions::default())
        .await
        .map_err(|e| format!("no se pudo entrar a la sala: {e}"))?;
    let room = Arc::new(room);
    let identidad = room.local_participant().identity().to_string();

    // AEC encendido: sin él, hablar con altavoces se convierte en un bucle de
    // realimentación. El SDK lo expone y comprobarlo fue lo primero del spike.
    let fuente = NativeAudioSource::new(
        AudioSourceOptions {
            echo_cancellation: true,
            noise_suppression: true,
            auto_gain_control: true,
        },
        SAMPLE_RATE,
        CANALES,
        1_000,
    );
    let pista = LocalAudioTrack::create_audio_track("micro", RtcAudioSource::Native(fuente.clone()));
    room.local_participant()
        .publish_track(
            LocalTrack::Audio(pista),
            TrackPublishOptions { source: TrackSource::Microphone, ..Default::default() },
        )
        .await
        .map_err(|e| format!("no se pudo publicar el micrófono: {e}"))?;

    let captura = arrancar_captura(fuente.clone())?;

    on_event
        .send(VoiceEvent::Connected { identity: identidad.clone() })
        .map_err(|e| e.to_string())?;

    *SESION.lock().unwrap() = Some(VoiceSession {
        room: room.clone(),
        _captura: captura,
        fuente,
    });

    escuchar_eventos(eventos, on_event);
    Ok(identidad)
}

/// Salir. Idempotente: colgar dos veces no es un error que merezca una pantalla
/// roja, y el segundo intento llega de verdad cuando la ventana se cierra
/// mientras alguien pulsaba el botón.
#[tauri::command]
pub async fn voice_leave() {
    let sesion = SESION.lock().unwrap().take();
    if let Some(s) = sesion {
        // El guard de captura muere con `s` y con él el hilo del micrófono.
        let _ = s.room.close().await;
    }
}

/// Silenciar sin salirse. Se apaga en la **fuente** y no parando la captura:
/// así el flujo sigue vivo y volver a hablar es inmediato, en vez de tener que
/// levantar otra vez el dispositivo de audio.
#[tauri::command]
pub fn voice_set_mic(enabled: bool) -> Result<(), String> {
    let guard = SESION.lock().unwrap();
    let s = guard.as_ref().ok_or("no estás en ninguna sala")?;
    s.fuente.set_audio_options(AudioSourceOptions {
        echo_cancellation: true,
        noise_suppression: true,
        auto_gain_control: true,
    });
    SILENCIADO.store(!enabled, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Silenciar de verdad: la captura sigue corriendo y lo que se publica es
/// silencio. Parar el dispositivo daría un corte audible al volver.
static SILENCIADO: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Al cerrar la ventana. Sin esto queda una sala abierta y un micrófono vivo en
/// un proceso que ya nadie mira — la misma lección que el pty.
pub fn close_all() {
    let sesion = SESION.lock().unwrap().take();
    if let Some(s) = sesion {
        tauri::async_runtime::spawn(async move {
            let _ = s.room.close().await;
        });
    }
}

/// El micrófono del sistema, en su propio hilo.
///
/// cpal entrega tramas del tamaño que le da la gana; libwebrtc las quiere de
/// 10 ms exactos. El acumulador de aquí en medio es lo que traduce entre las dos
/// cosas, y sin él la voz sale troceada.
fn arrancar_captura(fuente: NativeAudioSource) -> Result<StreamGuard, String> {
    let (fin_tx, fin_rx) = std::sync::mpsc::channel::<()>();
    let (listo_tx, listo_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        let host = cpal::default_host();
        let dispositivo = match host.default_input_device() {
            Some(d) => d,
            None => {
                let _ = listo_tx.send(Err("no hay micrófono".into()));
                return;
            }
        };
        let config = match dispositivo.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = listo_tx.send(Err(format!("el micrófono no dice su formato: {e}")));
                return;
            }
        };
        let entrada_rate = config.sample_rate();
        let entrada_canales = config.channels() as usize;

        let (tramas_tx, mut tramas_rx) = mpsc::unbounded_channel::<Vec<i16>>();
        let mut acumulador: Vec<i16> = Vec::with_capacity(MUESTRAS_POR_TRAMA * 2);

        let stream = dispositivo.build_input_stream(
            config.config(),
            move |datos: &[f32], _: &cpal::InputCallbackInfo| {
                // A mono, promediando: publicar sólo el canal izquierdo pierde
                // la mitad de la señal en micrófonos estéreo.
                for trozo in datos.chunks(entrada_canales) {
                    let media = trozo.iter().sum::<f32>() / trozo.len() as f32;
                    let muestra = if SILENCIADO.load(std::sync::atomic::Ordering::Relaxed) {
                        0
                    } else {
                        (media.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                    };
                    acumulador.push(muestra);
                }
                while acumulador.len() >= MUESTRAS_POR_TRAMA {
                    let resto = acumulador.split_off(MUESTRAS_POR_TRAMA);
                    let trama = std::mem::replace(&mut acumulador, resto);
                    let _ = tramas_tx.send(trama);
                }
            },
            |e| eprintln!("voz: error de captura: {e}"),
            None,
        );
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                let _ = listo_tx.send(Err(format!("no se pudo abrir el micrófono: {e}")));
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = listo_tx.send(Err(format!("no se pudo arrancar el micrófono: {e}")));
            return;
        }
        let _ = listo_tx.send(Ok(()));

        // El puente al SDK vive en el runtime de tauri; este hilo sólo espera la
        // orden de morir, que es lo que mantiene vivo al `stream` de cpal.
        tauri::async_runtime::spawn(async move {
            while let Some(datos) = tramas_rx.recv().await {
                let trama = AudioFrame {
                    data: datos.into(),
                    sample_rate: entrada_rate,
                    num_channels: 1,
                    samples_per_channel: MUESTRAS_POR_TRAMA as u32,
                };
                if fuente.capture_frame(&trama).await.is_err() {
                    break;
                }
            }
        });

        let _ = fin_rx.recv();
        drop(stream);
    });

    match listo_rx.recv() {
        Ok(Ok(())) => Ok(StreamGuard(Some(fin_tx))),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("el hilo del micrófono murió al arrancar".into()),
    }
}

/// Traduce los eventos de la sala a lo que la pantalla entiende, y reproduce lo
/// que dicen los demás.
fn escuchar_eventos(mut eventos: mpsc::UnboundedReceiver<RoomEvent>, canal: Channel<VoiceEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = eventos.recv().await {
            let enviado = match ev {
                RoomEvent::ParticipantConnected(p) => canal.send(VoiceEvent::Joined {
                    identity: p.identity().to_string(),
                    name: p.name().to_string(),
                }),
                RoomEvent::ParticipantDisconnected(p) => {
                    canal.send(VoiceEvent::Left { identity: p.identity().to_string() })
                }
                RoomEvent::ActiveSpeakersChanged { speakers } => canal.send(VoiceEvent::Speaking {
                    identities: speakers.iter().map(|s| s.identity().to_string()).collect(),
                }),
                RoomEvent::TrackSubscribed { track, .. } => {
                    if let RemoteTrack::Audio(audio) = track {
                        reproducir(audio.rtc_track());
                    }
                    Ok(())
                }
                RoomEvent::Disconnected { reason } => {
                    canal.send(VoiceEvent::Disconnected { reason: format!("{reason:?}") })
                }
                _ => Ok(()),
            };
            if enviado.is_err() {
                break; // la pantalla se fue; no hay a quién contarle nada
            }
        }
    });
}

/// Lo que dice otro, por los altavoces.
///
/// Un stream de cpal por pista remota. Con dos o cinco personas eso son dos o
/// cinco dispositivos de salida abiertos, que el sistema mezcla — más simple y
/// más robusto que mantener un mezclador propio, y a este tamaño de equipo la
/// diferencia no se nota.
fn reproducir(pista: livekit::webrtc::prelude::RtcAudioTrack) {
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(dispositivo) = host.default_output_device() else { return };
        let Ok(config) = dispositivo.default_output_config() else { return };
        let salida_canales = config.channels() as usize;

        let cola = Arc::new(Mutex::new(std::collections::VecDeque::<i16>::new()));
        let cola_cb = cola.clone();
        let stream = dispositivo.build_output_stream(
            config.config(),
            move |salida: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let mut q = cola_cb.lock().unwrap();
                for trozo in salida.chunks_mut(salida_canales) {
                    // Silencio cuando la cola se vacía: es preferible un hueco
                    // a repetir la última muestra, que suena a chirrido.
                    let v = q.pop_front().map(|s| s as f32 / i16::MAX as f32).unwrap_or(0.0);
                    for canal in trozo.iter_mut() {
                        *canal = v;
                    }
                }
            },
            |e| eprintln!("voz: error de reproducción: {e}"),
            None,
        );
        let Ok(stream) = stream else { return };
        if stream.play().is_err() {
            return;
        }

        let mut entrante = NativeAudioStream::new(pista, config.sample_rate() as i32, 1);
        tauri::async_runtime::block_on(async {
            while let Some(trama) = entrante.next().await {
                let mut q = cola.lock().unwrap();
                // Un tope: si nadie consume —altavoz dormido, sistema
                // ocupado— la cola crecería sin fin y la latencia con ella.
                if q.len() > SAMPLE_RATE as usize {
                    q.clear();
                }
                q.extend(trama.data.iter().copied());
            }
        });
        drop(stream);
    });
}

// ─── Vídeo: cámara y pantalla ─────────────────────────────────────────────────
//
// Mismo reparto que el audio: la captura es del sistema y la publicación es del
// SDK. Lo único propio de aquí es la traducción entre los dos, que en vídeo es
// el formato de píxel — las cámaras entregan RGB y WebRTC quiere I420.

/// Qué se está publicando además de la voz, para que la pantalla lo sepa sin
/// preguntar.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoState {
    pub camera: bool,
    pub screen: bool,
}

/// 720p a 30 fps. Suficiente para una cara y para leer código compartido, y la
/// mitad de ancho de banda que 1080p — que en una llamada de trabajo nadie echa
/// de menos.
const VIDEO_ANCHO: u32 = 1280;
const VIDEO_ALTO: u32 = 720;

/// RGB de la cámara → I420, que es lo que WebRTC transporta.
///
/// A mano y no con los ayudantes del SDK porque los suyos van a NV12 y de ahí a
/// I420: dos conversiones y una copia de más por trama, treinta veces por
/// segundo. Esta es la aritmética de BT.601 y cabe en veinte líneas.
///
/// El submuestreo de croma toma **una** muestra por bloque de 2×2 en vez de
/// promediar los cuatro. Es lo que hace la mayoría de las cámaras al entregar
/// YUY2, y la diferencia no se ve en una cara a 720p.
fn rgb_a_i420(rgb: &[u8], ancho: u32, alto: u32, destino: &mut I420Buffer) {
    let (w, h) = (ancho as usize, alto as usize);
    let (sy, su, _sv) = destino.strides();
    let (y_plano, u_plano, v_plano) = destino.data_mut();

    for fila in 0..h {
        for col in 0..w {
            let i = (fila * w + col) * 3;
            let (r, g, b) = (rgb[i] as f32, rgb[i + 1] as f32, rgb[i + 2] as f32);
            y_plano[fila * sy as usize + col] =
                (0.257 * r + 0.504 * g + 0.098 * b + 16.0).clamp(0.0, 255.0) as u8;

            // Un píxel de croma por cada cuatro de luma.
            if fila % 2 == 0 && col % 2 == 0 {
                let idx = (fila / 2) * su as usize + col / 2;
                u_plano[idx] = (-0.148 * r - 0.291 * g + 0.439 * b + 128.0).clamp(0.0, 255.0) as u8;
                v_plano[idx] = (0.439 * r - 0.368 * g - 0.071 * b + 128.0).clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Enciende o apaga la cámara sin tocar la voz.
///
/// Son pistas independientes a propósito: apagar la cámara en mitad de una frase
/// no debería cortar lo que estás diciendo, y unirlas obligaría a republicar el
/// audio cada vez que alguien se tapa.
#[tauri::command]
pub async fn voice_set_camera(enabled: bool) -> Result<VideoState, String> {
    let room = {
        let guard = SESION.lock().unwrap();
        let s = guard.as_ref().ok_or("no estás en ninguna sala")?;
        s.room.clone()
    };

    if !enabled {
        despublicar(&room, TrackSource::Camera).await;
        CAMARA.store(false, std::sync::atomic::Ordering::Relaxed);
        return Ok(estado_video());
    }

    // `is_screencast: false` — una cara. El SFU lo usa para decidir su
    // estrategia: en una cámara prioriza la fluidez, en una pantalla el detalle
    // del texto aunque baje la tasa.
    let fuente = NativeVideoSource::new(
        VideoResolution { width: VIDEO_ANCHO, height: VIDEO_ALTO },
        false,
    );
    arrancar_camara(fuente.clone())?;
    let pista = LocalVideoTrack::create_video_track("camara", RtcVideoSource::Native(fuente));
    room.local_participant()
        .publish_track(
            LocalTrack::Video(pista),
            TrackPublishOptions { source: TrackSource::Camera, ..Default::default() },
        )
        .await
        .map_err(|e| format!("no se pudo publicar la cámara: {e}"))?;
    CAMARA.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(estado_video())
}

static CAMARA: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PANTALLA: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn estado_video() -> VideoState {
    use std::sync::atomic::Ordering::Relaxed;
    VideoState { camera: CAMARA.load(Relaxed), screen: PANTALLA.load(Relaxed) }
}

/// Retira la pista de una fuente. Se busca por `source` y no por nombre: el
/// nombre es nuestro y podría cambiar, la fuente es lo que el otro extremo usa
/// para decidir si eso es una cara o una pantalla.
async fn despublicar(room: &Arc<Room>, fuente: TrackSource) {
    let sids: Vec<_> = room
        .local_participant()
        .track_publications()
        .iter()
        .filter(|(_, pub_)| pub_.source() == fuente)
        .map(|(sid, _)| sid.clone())
        .collect();
    for sid in sids {
        let _ = room.local_participant().unpublish_track(&sid).await;
    }
}

/// La cámara del sistema, en su propio hilo.
fn arrancar_camara(fuente: NativeVideoSource) -> Result<(), String> {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{CameraIndex, RequestedFormat, RequestedFormatType};
    use nokhwa::Camera;

    let (listo_tx, listo_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let formato = RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
        let mut camara = match Camera::new(CameraIndex::Index(0), formato) {
            Ok(c) => c,
            Err(e) => {
                let _ = listo_tx.send(Err(format!("no se pudo abrir la cámara: {e}")));
                return;
            }
        };
        if let Err(e) = camara.open_stream() {
            let _ = listo_tx.send(Err(format!("no se pudo arrancar la cámara: {e}")));
            return;
        }
        let _ = listo_tx.send(Ok(()));

        while CAMARA.load(std::sync::atomic::Ordering::Relaxed) {
            // Un buffer por trama: `I420Buffer` no se puede clonar y el frame
            // se lo lleva. Reusarlo exigiría que la conversión y el envío no se
            // solapen, que es sincronización a cambio de una asignación que el
            // asignador resuelve en nada.
            let mut buffer = I420Buffer::new(VIDEO_ANCHO, VIDEO_ALTO);
            let Ok(trama) = camara.frame() else { break };
            let Ok(rgb) = trama.decode_image::<RgbFormat>() else { continue };
            // Sólo si la cámara entrega justo lo que pedimos: escalar aquí sería
            // meter un reescalador por software en el camino caliente, y el
            // sitio correcto para eso es pedirle a la cámara otra resolución.
            if rgb.width() != VIDEO_ANCHO || rgb.height() != VIDEO_ALTO {
                continue;
            }
            rgb_a_i420(rgb.as_raw(), VIDEO_ANCHO, VIDEO_ALTO, &mut buffer);
            fuente.capture_frame(&VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_micros() as i64)
                    .unwrap_or(0),
                buffer,
                frame_metadata: Default::default(),
            });
        }
        let _ = camara.stop_stream();
    });

    match listo_rx.recv() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("el hilo de la cámara murió al arrancar".into()),
    }
}
