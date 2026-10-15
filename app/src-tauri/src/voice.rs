//! Los canales de voz, con el motor dentro del proceso y no en el webview.
//!
//! **Por qué nativo.** El plan natural era `livekit-client` en el webview, y en
//! Windows y macOS habría bastado. En Linux no: el WebKitGTK de Arch viene
//! *compilado* sin WebRTC — cero símbolos de `JSRTCPeerConnection` en la
//! biblioteca del sistema, y la propiedad `enable-webrtc` es una puerta sin
//! habitación detrás. No es configurable. Se midió antes de decidir, y el acta
//! está en `docs/voice.md`.
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
use livekit::track::{
    LocalAudioTrack, LocalTrack, LocalVideoTrack, RemoteTrack, TrackKind, TrackSource,
};
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::native::apm::AudioProcessingModule;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::{
    AudioFrame, I420Buffer, VideoFrame, VideoResolution, VideoRotation,
};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::RtcVideoSource;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use livekit::{Room, RoomEvent, RoomOptions};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_stream::StreamExt;

/// 48 kHz mono: lo que WebRTC usa internamente. Publicar en su tasa evita un
/// remuestreo que sólo añadiría latencia y una cosa más que puede sonar mal.
const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u32 = 1;
/// 10 ms por trama, que es el tamaño que espera libwebrtc.
const SAMPLES_PER_FRAME: usize = SAMPLE_RATE as usize / 100;

/// A partir de qué energía se considera que alguien está hablando.
///
/// Sobre 1 en escala completa. Un 2 % deja fuera el ruido de fondo de una
/// habitación y el zumbido de un ventilador, y entra con voz normal a medio
/// metro del micrófono.
const VOICE_THRESHOLD: f32 = 0.02;

/// Cuánto se mantiene encendido el indicador tras la última trama con voz.
///
/// Sin esto parpadea entre palabra y palabra —y entre sílabas— porque el
/// silencio de una coma también baja del umbral. Trescientos milisegundos es
/// más que la pausa de una frase y menos que la de un turno de conversación.
const VOICE_HANGOVER: std::time::Duration = std::time::Duration::from_millis(300);

/// Lo que la sala le cuenta a la pantalla.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoiceEvent {
    /// Dentro. `identity` es el id de usuario de cac — el mismo que acuñó el
    /// token, así que la pantalla puede cruzarlo con la gente que ya conoce.
    Connected {
        identity: String,
    },
    Joined {
        identity: String,
        name: String,
    },
    Left {
        identity: String,
    },
    /// Quién está hablando ahora mismo. Llega la lista entera y no un delta:
    /// reconstruir el conjunto a base de altas y bajas es cómo se acaba con un
    /// punto verde encendido para siempre por un evento perdido.
    Speaking {
        identities: Vec<String>,
    },
    /// Quién tiene el micrófono cerrado. Uno a uno y no la lista entera, porque
    /// aquí sí llega un evento por cambio y no un estado completo: el SDK avisa
    /// de la pista que se silencia, no de las que siguen igual.
    Muted {
        identity: String,
        muted: bool,
    },
    /// Ida y vuelta al SFU, en milisegundos.
    Latency {
        ms: u32,
    },
    /// Esta persona está publicando vídeo, o dejó de hacerlo.
    ///
    /// `source` es `"camera"` o `"screen"`, y no sobra: una persona puede
    /// publicar las dos a la vez, y la pantalla compartida no va en su mosaico
    /// sino ocupando el escenario.
    Video {
        identity: String,
        source: String,
        enabled: bool,
    },
    /// **Tú** estás hablando, medido de tu propio micrófono.
    ///
    /// Va aparte de `Speaking` a propósito. Aquélla es la lista que manda el
    /// servidor, que tarda su medio segundo en decidirla y —según cómo esté
    /// configurado el observador de niveles— puede no incluirte a ti nunca. Tu
    /// propio recuadro no debería depender de que un servidor opine sobre algo
    /// que está pasando en tu mesa.
    SelfSpeaking {
        speaking: bool,
    },
    /// Se está grabando esta llamada, o se ha dejado de grabar.
    ///
    /// Sale del **metadata de la sala**, no de un mensaje aparte, y ésa es la
    /// diferencia que importa: LiveKit le entrega el metadata a cualquiera que
    /// se conecte, así que quien entra tarde ve el chip REC sin que nadie tenga
    /// que repetirle nada. Un aviso por SSE sólo llega a quien ya estaba.
    Recording {
        active: bool,
        /// El id de la grabación y quién la empezó. Vacíos cuando `active` es
        /// falso: al parar no hay nada que nombrar.
        id: String,
        by: String,
        since: String,
    },
    Disconnected {
        reason: String,
    },
}

/// Lo que dice el metadata de la sala cuando hay grabación.
///
/// Es el mismo objeto que escribe el backend en `markRoom`; aquí sólo se lee.
#[derive(Debug, PartialEq)]
pub struct RecordingSignal {
    pub id: String,
    pub by: String,
    pub since: String,
}

/// Lee el metadata de la sala y dice si hay grabación.
///
/// Pura y aparte del bucle de eventos para poder probarla: el metadata lo
/// escribe otro proceso, puede llegar vacío —una sala recién creada—, puede no
/// ser JSON, y puede traer `"recording": null` cuando se acaba de parar. Los
/// tres casos significan lo mismo y ninguno es un error.
///
/// **Se exigen `id` y `by`.** Un objeto presente pero a medias no enciende el
/// chip: preferimos no avisar a avisar de una grabación que no se sabe de quién
/// es — el aviso sin dueño es exactamente el que da miedo.
pub fn recording_from_metadata(raw: &str) -> Option<RecordingSignal> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let rec = value.get("recording")?;
    let id = rec.get("id")?.as_str()?;
    let by = rec.get("by")?.as_str()?;
    if id.is_empty() || by.is_empty() {
        return None;
    }
    Some(RecordingSignal {
        id: id.to_string(),
        by: by.to_string(),
        since: rec.get("since").and_then(|s| s.as_str()).unwrap_or("").to_string(),
    })
}

/// El evento que corresponde a un metadata, encendido o apagado.
fn recording_event(raw: &str) -> VoiceEvent {
    match recording_from_metadata(raw) {
        Some(r) => VoiceEvent::Recording {
            active: true,
            id: r.id,
            by: r.by,
            since: r.since,
        },
        None => VoiceEvent::Recording {
            active: false,
            id: String::new(),
            by: String::new(),
            since: String::new(),
        },
    }
}

struct VoiceSession {
    room: Arc<Room>,
    /// Se retienen para que la captura siga viva: soltar el stream de cpal lo
    /// para, y soltar la fuente corta lo que se publica.
    // Mutable: cambiar de micrófono la sustituye sin salirse de la llamada.
    _capture: StreamGuard,
    source_handle: NativeAudioSource,
    /// La pista publicada, para poder silenciarla **en la pista** y no sólo en
    /// las muestras. Ver `voice_set_mic`.
    mic: LocalAudioTrack,
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

static SESSION: LazyLock<Mutex<Option<VoiceSession>>> = LazyLock::new(|| Mutex::new(None));

/// Entrar a una sala. Una a la vez: estar en dos conversaciones de voz al mismo
/// tiempo no es algo que nadie quiera, y permitirlo sería mezclar dos micrófonos
/// abiertos sin que se note cuál es cuál.
#[tauri::command]
pub async fn voice_join(
    url: String,
    token: String,
    on_event: Channel<VoiceEvent>,
    meta: Option<serde_json::Value>,
) -> Result<String, String> {
    // Se baja al salir por cualquier camino, `?` incluido.
    struct Joining;
    impl Drop for Joining {
        fn drop(&mut self) {
            JOINING.store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }
    JOINING.store(true, std::sync::atomic::Ordering::Relaxed);
    let _joining = Joining;

    // El permiso del micrófono, **antes** de entrar a la sala: si se pide al
    // abrir la captura, ya estás publicado en el SFU mientras el aviso de macOS
    // espera, y los demás te ven dentro de una llamada en la que no se te oye.
    // En un hilo aparte porque la respuesta tarda lo que tarde la persona.
    tokio::task::spawn_blocking(microphone_permission)
        .await
        .map_err(|e| e.to_string())??;

    voice_leave().await;

    let (room, events) = Room::connect(&url, &token, RoomOptions::default())
        .await
        .map_err(|e| format!("no se pudo entrar a la sala: {e}"))?;
    let room = Arc::new(room);
    let identity_of = room.local_participant().identity().to_string();

    // **Estas tres opciones no hacen nada aquí**, y durante meses se creyó lo
    // contrario. Con una fuente nativa (`capture_frame`), webrtc-sys pasa cada
    // trama directa a los sumideros: el procesado de audio de WebRTC sólo corre
    // cuando el SDK captura el dispositivo él mismo, que no es el caso. El
    // procesado de verdad lo hace `Processor` en la captura (ver
    // `start_capture_thread` y `docs/voice.md`). Se dejan a `true` porque son lo que
    // se quiere y no cuestan nada, no porque se apliquen.
    let source_handle = NativeAudioSource::new(
        AudioSourceOptions {
            echo_cancellation: true,
            noise_suppression: true,
            auto_gain_control: true,
        },
        SAMPLE_RATE,
        CHANNELS,
        1_000,
    );
    let track_rtc =
        LocalAudioTrack::create_audio_track("micro", RtcAudioSource::Native(source_handle.clone()));

    // Todo lo que puede fallar **después de estar conectado**, junto y en un
    // solo sitio, para poder cerrar la sala si algo se tuerce.
    //
    // Antes esto eran tres `?` sueltos, y cada uno se llevaba por delante el
    // `Arc<Room>` sin cerrarlo: quedabas publicado en el SFU y sin nadie que
    // colgara, porque `voice_leave` sólo cierra lo que encuentre en `SESSION` y
    // `SESSION` todavía no estaba puesto. El resultado era un participante
    // fantasma que sólo desaparecía cuando LiveKit lo segaba por su cuenta —y,
    // como la presencia se lee del SFU, mientras tanto te veías a ti mismo
    // dentro de una llamada de la que ya no formabas parte.
    let armed = async {
        room.local_participant()
            .publish_track(
                LocalTrack::Audio(track_rtc.clone()),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| format!("no se pudo publicar el micrófono: {e}"))?;

        *CHANNEL.lock().unwrap() = Some(on_event.clone());
        *ME.lock().unwrap() = Some(identity_of.clone());
        *META.lock().unwrap() = meta.clone();
        note(format!("sala: dentro como {identity_of}"));
        let capture = start_capture_thread(source_handle.clone())?;

        on_event
            .send(VoiceEvent::Connected {
                identity: identity_of.clone(),
            })
            .map_err(|e| e.to_string())?;

        Ok::<_, String>(VoiceSession {
            room: room.clone(),
            _capture: capture,
            source_handle: source_handle.clone(),
            mic: track_rtc.clone(),
        })
    }
    .await;

    let session = match armed {
        Ok(s) => s,
        Err(e) => {
            note(format!("sala: entrada a medias, se cierra la sala — {e}"));
            let _ = room.close().await;
            *CHANNEL.lock().unwrap() = None;
            *ME.lock().unwrap() = None;
            *META.lock().unwrap() = None;
            return Err(e);
        }
    };
    *SESSION.lock().unwrap() = Some(session);

    listen_to_events(events, Arc::downgrade(&room));
    measure_latency(Arc::downgrade(&room));
    Ok(identity_of)
}

/// Salir. Idempotente: colgar dos veces no es un error que merezca una pantalla
/// roja, y el segundo intento llega de verdad cuando la ventana se cierra
/// mientras alguien pulsaba el botón.
#[tauri::command]
pub async fn voice_leave() {
    // Las capturas de vídeo se paran aquí, y esto es lo que impide un hilo
    // huérfano por llamada. Las dos banderas son la única correa que tienen:
    // sin bajarlas, el hilo de la cámara sigue pidiendo tramas y convirtiendo
    // espacios de color para siempre después de colgar — y como `voice_join`
    // llama a esto antes de entrar, entrar a dos salas seguidas dejaba dos
    // cámaras corriendo a la vez.
    use std::sync::atomic::Ordering::Relaxed;
    if ME.lock().unwrap().is_some() {
        note("sala: fuera");
    }
    CAMERA_ON.store(false, Relaxed);
    SCREEN_ON.store(false, Relaxed);
    // Las caras de la sala anterior no se heredan.
    crate::video_frames::olvidar_todo();
    *ME.lock().unwrap() = None;
    *META.lock().unwrap() = None;
    // La sordera no se hereda: entrar a otra sala sin oír a nadie, y sin que la
    // pantalla lo diga porque el store ya se vació, es un fallo mudo.
    DEAFENED.store(false, std::sync::atomic::Ordering::Relaxed);
    let session = SESSION.lock().unwrap().take();
    if let Some(s) = session {
        // El guard de captura muere con `s` y con él el hilo del micrófono.
        let _ = s.room.close().await;
    }
    close_output();
}

/// Silenciar sin salirse.
///
/// Se silencia **la pista** y no sólo las muestras, y esa es la diferencia que
/// importa: zerear lo que se publica te deja callado, pero para el resto de la
/// sala sigues con el micrófono abierto —el SFU no distingue tu silencio del
/// silencio— y su icono de «mudo» nunca se enciende. `mute()` sí viaja: el
/// servidor lo reparte y a los demás les llega un `TrackMuted`.
///
/// Las muestras se siguen zereando además de eso. Es redundante mientras la
/// pista esté muda, y es lo que garantiza que entre pulsar el botón y que el
/// servidor se entere no salga media palabra.
///
/// Lo que **no** se hace es parar la captura: el flujo sigue vivo y volver a
/// hablar es inmediato, en vez de tener que levantar otra vez el dispositivo.
///
/// # Es `async`, y eso no es cosmético
///
/// Fue `pub fn` una versión y **cerraba la app al silenciarse**, en Windows y
/// en Linux. Tauri corre los comandos síncronos en el hilo principal, que no
/// está dentro de ningún runtime de Tokio; `mute()` avisa al servidor con un
/// `tokio::task::spawn`, y eso entra en pánico fuera de un runtime. Un pánico
/// en el hilo principal se lleva el proceso por delante.
///
/// **Regla, entonces: todo comando que toque el SDK de LiveKit va `async`.**
/// `voice_set_camera` lo era desde el principio y por eso nunca falló; éste no,
/// y el fallo no aparece hasta que alguien pulsa el botón con una llamada
/// abierta — ninguna prueba de las que tenemos llega ahí.
#[tauri::command]
pub async fn voice_set_mic(enabled: bool) -> Result<(), String> {
    // La pista se saca del candado y el candado se suelta antes de tocarla: lo
    // que hace `mute()` por dentro no es asunto de este bloqueo, y sostenerlo
    // mientras el SDK hace cosas es cómo se inventan los interbloqueos.
    let mic = {
        let guard = SESSION.lock().unwrap();
        match guard.as_ref() {
            Some(s) => s.mic.clone(),
            None => return Err("voice-not-in-room".into()),
        }
    };
    MUTED.store(!enabled, std::sync::atomic::Ordering::Relaxed);
    note(if enabled {
        "micro: abierto"
    } else {
        "micro: silenciado"
    });
    if enabled {
        mic.unmute();
    } else {
        mic.mute();
    }
    Ok(())
}

/// Silenciar de verdad: la captura sigue corriendo y lo que se publica es
/// silencio. Parar el dispositivo daría un corte audible al volver.
static MUTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Si se procesa la voz antes de mandarla: supresión de ruido, filtro de graves
/// y control de ganancia (ver `Processor`). Encendido por defecto; se apaga
/// para música o un instrumento, que el supresor confunde con ruido.
static NOISE_SUPPRESSION: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Enciende o apaga el procesado de la voz. En caliente: la captura lo lee en
/// cada trama, sin reiniciarse. Fuera de una llamada también vale, para la
/// siguiente.
#[tauri::command]
pub async fn voice_set_noise_suppression(on: bool) {
    NOISE_SUPPRESSION.store(on, std::sync::atomic::Ordering::Relaxed);
    note(if on {
        "micro: supresión de ruido encendida"
    } else {
        "micro: supresión de ruido apagada"
    });
}

/// El procesado de la voz que WebRTC no hace por nosotros.
///
/// La fuente nativa no aplica sus opciones (ver dónde se crea, en
/// `voice_join`), así que hasta la v1.6.96 el escritorio mandaba el micro
/// **crudo**: el ventilador, el teclado y el zumbido llegaban tal cual. Esto es
/// el módulo de procesado de WebRTC del propio SDK (`AudioProcessingModule`),
/// sin dependencias nuevas, aplicado a cada trama de 10 ms antes de publicarla.
///
/// **Con cancelación de eco desde la v1.6.101** (fase 2 de `docs/voice.md`).
/// El cancelador necesita, como referencia, lo que suena por los altavoces:
/// sin eso no sabe qué restar. Hasta entonces cada pista remota sonaba por su
/// propio flujo de cpal y no había una mezcla que darle, así que iba apagado y
/// quien te escuchaba con altavoces te devolvía tu propia voz por su micrófono
/// (Alexander, en Mac, 15-oct-2026). Ahora todo suena por una sola salida
/// (`Mezclador`), que deja lo que reproduce en `RENDER_REFERENCE`; antes de cada
/// trama del micrófono se le pasa al módulo con `process_reverse_stream`.
///
/// **Sin control de ganancia desde entonces**, y medido: con el cancelador
/// encendido, el control de ganancia vuelve a subir el ruido que el supresor
/// acaba de bajar —un ruido sostenido pasaba de −14 dB a −0,2 dB— y el
/// ventilador volvía a encender el aro de hablar. Sin él: el ruido baja 15 dB
/// y un eco a −10 dB y 30 ms de retardo baja 69 dB (`processing_tests`).
///
/// Apagado (la música, un instrumento) no se toca nada, eco incluido, como
/// antes: es para mandar el sonido tal cual.
///
/// Una instancia por captura: cambiar de micrófono empieza otra, que aprende el
/// ruido y el eco desde cero en unos cientos de milisegundos.
struct Processor {
    apm: Option<AudioProcessingModule>,
}

impl Processor {
    fn new() -> Self {
        Self { apm: None }
    }

    /// Procesa una trama en su sitio, después de darle al cancelador lo que
    /// sonó desde la anterior (`reference`, en tramas de 10 ms). `on` apagado
    /// la deja tal cual (y suelta el módulo: al volver a encender empieza
    /// limpio).
    ///
    /// La referencia llega como argumento y no se lee aquí de `RENDER_REFERENCE`
    /// para poder probar el cancelador sin una tarjeta de sonido.
    ///
    /// `process_stream` **hace panic** si la longitud no es un múltiplo de
    /// 10 ms; antes de llamarlo se comprueba, y una trama que no cuadra se
    /// devuelve como error y sin tocar: mejor sin procesar que tirar la
    /// captura.
    fn process_frame(&mut self, on: bool, rtc_frame: &mut [i16], reference: Vec<Vec<i16>>) -> Result<(), String> {
        if !on {
            self.apm = None;
            return Ok(());
        }
        if rtc_frame.is_empty() || rtc_frame.len() % SAMPLES_PER_FRAME != 0 {
            return Err(format!("trama de {} muestras, no múltiplo de 10 ms", rtc_frame.len()));
        }
        // (eco, ganancia, paso alto, ruido).
        let apm = self
            .apm
            .get_or_insert_with(|| AudioProcessingModule::new(true, false, true, true));
        // Lo que sonó, antes de la trama: el cancelador tiene que haber oído
        // la referencia para poder restarla.
        for mut reference in reference {
            apm.process_reverse_stream(&mut reference, SAMPLE_RATE as i32, CHANNELS as i32)
                .map_err(|e| e.to_string())?;
        }
        apm.process_stream(rtc_frame, SAMPLE_RATE as i32, CHANNELS as i32)
            .map_err(|e| e.to_string())
    }
}

// ─── Lo que suena: una sola salida, que es la referencia del eco ──────────────

/// Lo que ha sonado por los altavoces y el cancelador todavía no ha visto, a
/// `SAMPLE_RATE` y en mono. Lo llena la salida (`Mezclador`) y lo vacía la
/// captura (`Processor`).
static RENDER_REFERENCE: Mutex<std::collections::VecDeque<i16>> = Mutex::new(std::collections::VecDeque::new());

/// Cuánta referencia se guarda como mucho: 200 ms. Si la captura no la
/// consume —micro parado, cambiando de dispositivo—, lo viejo no sirve para
/// cancelar nada y sólo desalinearía lo que llega después.
const RENDER_REFERENCE_MAX: usize = SAMPLES_PER_FRAME * 20;

/// Lo que sonó, en tramas de 10 ms, y lo que no llega a trama se queda para
/// la siguiente vez.
fn take_reference() -> Vec<Vec<i16>> {
    frames_of(&mut RENDER_REFERENCE.lock().unwrap())
}

fn frames_of(queue: &mut std::collections::VecDeque<i16>) -> Vec<Vec<i16>> {
    let mut out = Vec::with_capacity(queue.len() / SAMPLES_PER_FRAME);
    while queue.len() >= SAMPLES_PER_FRAME {
        out.push(queue.drain(..SAMPLES_PER_FRAME).collect());
    }
    out
}

/// Deja lo que acaba de sonar para el cancelador, sin pasar del tope.
fn note_reference(queue: &mut std::collections::VecDeque<i16>, frame_samples: &[i16]) {
    queue.extend(frame_samples.iter().copied());
    if queue.len() > RENDER_REFERENCE_MAX {
        let excess = queue.len() - RENDER_REFERENCE_MAX;
        queue.drain(..excess);
    }
}

/// Suma una muestra de cada persona, sin desbordar. En `i32` y recortada: dos
/// voces fuertes a la vez pasan de `i16::MAX`, y dar la vuelta suena a un
/// chasquido brutal; recortar sólo a algo áspero.
fn mix_samples(frame_samples: impl Iterator<Item = i16>) -> i16 {
    frame_samples
        .map(i32::from)
        .sum::<i32>()
        .clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

/// Lo que se guarda de cada pista antes de que empiece a sonar: 60 ms.
///
/// Sin colchón, la v1.6.101 sonaba a clics con una persona del navegador
/// (jose, 15-oct-2026, grabado con el teléfono). Las tramas llegan al ritmo
/// del SDK y la tarjeta de sonido consume al suyo, así que una cola que
/// empieza vacía ronda el cero, y cada vez que se vacía a mitad de un bloque
/// de la tarjeta sale un hueco de silencio: un clic. Con 60 ms de margen, el
/// vaivén de llegada de las tramas no la vacía.
const JITTER_CUSHION: usize = SAMPLES_PER_FRAME * 6;

/// Lo más que se deja acumular: 200 ms. Pasado eso se tira lo más viejo hasta
/// el colchón, en vez de vaciar la cola (que era otro hueco).
const QUEUE_MAX: usize = SAMPLES_PER_FRAME * 20;

/// Una pista remota en la mezcla: su cola a `SAMPLE_RATE` y mono, y si está
/// sonando o esperando a tener colchón.
#[derive(Default)]
struct MixTrack {
    queue: std::collections::VecDeque<i16>,
    playing: bool,
    /// Veces que se quedó sin muestras sonando. Va al diario: es la medida
    /// de los clics.
    gaps: u64,
}

impl MixTrack {
    /// Lo que llega del SDK.
    fn push_samples(&mut self, frame_samples: &[i16]) {
        self.queue.extend(frame_samples.iter().copied());
        if self.queue.len() > QUEUE_MAX {
            let excess = self.queue.len() - JITTER_CUSHION;
            self.queue.drain(..excess);
        }
    }

    /// La siguiente muestra para la mezcla. Sin colchón, silencio y a esperar;
    /// si se vacía sonando, cuenta un hueco y vuelve a esperar al colchón, en
    /// vez de ir soltando muestras sueltas entre huecos.
    fn next_sample(&mut self) -> i16 {
        if !self.playing {
            if self.queue.len() < JITTER_CUSHION {
                return 0;
            }
            self.playing = true;
        }
        match self.queue.pop_front() {
            Some(m) => m,
            None => {
                self.playing = false;
                self.gaps += 1;
                0
            }
        }
    }
}

/// Una trama del SDK, a mono. Se pide mono, pero si llegara con más canales
/// se promedian: tratar un estéreo intercalado como mono lo reproduciría a
/// media velocidad y llenaría la cola el doble de rápido.
fn to_mono(samples: &[i16], channel_count: usize) -> Vec<i16> {
    if channel_count <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channel_count)
        .map(|c| (c.iter().map(|&v| v as i32).sum::<i32>() / c.len() as i32) as i16)
        .collect()
}

/// Una pista en la mezcla, compartida entre su hilo y la salida.
type TrackQueue = Arc<Mutex<MixTrack>>;

static TRACKS: Mutex<Vec<TrackQueue>> = Mutex::new(Vec::new());

/// La salida, mientras haya llamada. Una sola para todas las pistas: es lo
/// que permite saber qué está sonando.
static OUTPUT: Mutex<Option<StreamGuard>> = Mutex::new(None);

/// Abre la salida si no está abierta.
fn ensure_output() {
    let mut output = OUTPUT.lock().unwrap();
    if output.is_some() {
        return;
    }
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            note("altavoz: no hay dispositivo de salida");
            return;
        };
        let Ok(config) = device.default_output_config() else {
            note("altavoz: el dispositivo no dice su formato");
            return;
        };
        let output_channels = config.channels() as usize;
        let rate_hz = config.sample_rate();
        note(format!("altavoz: «{device}» a {rate_hz} Hz, {output_channels} canal(es)"));
        // De `SAMPLE_RATE` (la mezcla) al ritmo del dispositivo, por
        // interpolación lineal como en la captura: `pos` es la fracción entre
        // la muestra anterior y la siguiente de la mezcla.
        let step = SAMPLE_RATE as f32 / rate_hz as f32;
        let (mut pos, mut before, mut after) = (1.0f32, 0i16, 0i16);
        let mut played: Vec<i16> = Vec::with_capacity(1024);

        let stream = device.build_output_stream(
            config.config(),
            move |output: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let deaf = DEAFENED.load(std::sync::atomic::Ordering::Relaxed);
                let tracks = TRACKS.lock().unwrap();
                let mut queues: Vec<_> = tracks.iter().map(|c| c.lock().unwrap()).collect();
                played.clear();
                for chunk in output.chunks_mut(output_channels) {
                    while pos >= 1.0 {
                        // Silencio cuando una cola se vacía: es preferible un
                        // hueco a repetir la última muestra, que suena a
                        // chirrido. Sordo también consume la muestra: si no,
                        // la cola crece mientras no oyes y al volver sonaría
                        // lo de hace un minuto.
                        let m = mix_samples(queues.iter_mut().map(|q| q.next_sample()));
                        let m = if deaf { 0 } else { m };
                        // Lo que suena, que es lo que el cancelador tiene que
                        // restar. Sordo no suena nada, y la referencia lo dice.
                        played.push(m);
                        before = after;
                        after = m;
                        pos -= 1.0;
                    }
                    let v = before as f32 + (after as f32 - before as f32) * pos;
                    pos += step;
                    let v = v / i16::MAX as f32;
                    for chan in chunk.iter_mut() {
                        *chan = v;
                    }
                }
                drop(queues);
                drop(tracks);
                note_reference(&mut RENDER_REFERENCE.lock().unwrap(), &played);
            },
            |e| note(format!("altavoz: error de reproducción: {e}")),
            None,
        );
        let Ok(stream) = stream else {
            note("altavoz: no se pudo abrir");
            return;
        };
        if stream.play().is_err() {
            note("altavoz: no se pudo arrancar");
            return;
        }
        let _ = stop_rx.recv();
        drop(stream);
    });
    *output = Some(StreamGuard(Some(stop_tx)));
}

/// Cierra la salida y olvida lo que sonaba. Al colgar.
fn close_output() {
    *OUTPUT.lock().unwrap() = None;
    TRACKS.lock().unwrap().clear();
    RENDER_REFERENCE.lock().unwrap().clear();
}

// ─── Lo que hace falta para contestar «¿por qué no se me oye?» ────────────────
//
// Nada de esto se medía, y por eso el caso de la v1.6.5x fue imposible: se sabía
// que alguien no se oía y **ninguna otra cosa**. Con esto, un botón dentro de la
// llamada puede decir si el micrófono entrega muestras, si esas muestras traen
// señal o son ceros, y si lo capturado llega de verdad a publicarse — que son
// tres fallos distintos con el mismo síntoma.

/// Cuántas tramas ha aceptado el SDK. Si se queda quieta, no estás subiendo.
static FRAMES_PUBLISHED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// El pico de la última trama capturada, en tanto por mil de la escala completa.
///
/// Entero y atómico para poder leerlo desde otro hilo sin candado. Distingue el
/// fallo más engañoso de todos: capturar perfectamente y entregar silencio.
static PEAK_PERMILLE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Si el bucle de publicación sigue vivo. Ver dónde se pone en falso: un
/// `capture_frame` rechazado lo mataba **en silencio**, y ése es exactamente el
/// modo de fallo que no se podía ver desde fuera.
static PUBLISHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Lo último que dijo el micrófono al romperse, si dijo algo.
static LAST_CAPTURE_ERROR: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// Con qué formato quedó abierto el micrófono, para poder contarlo.
static INPUT_FORMAT: LazyLock<Mutex<Option<InputFormat>>> =
    LazyLock::new(|| Mutex::new(None));

// `camelCase` al salir. Sin esto `source_rate` viaja con el nombre de
// Rust, el TypeScript lo busca en `ritmoDeLaFuente` y no lo encuentra — y el
// veredicto salía diciendo «la fuente espera **undefined** Hz». Los demás
// campos son de una sola palabra y colaban por casualidad, que es lo que hizo
// que sólo se rompiera uno.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
// Las claves del cable siguen siendo las que lee la página
// (`voice-engine/types.ts`): se renombran allí y aquí a la vez, no por un lado.
pub struct InputFormat {
    #[serde(rename = "dispositivo")]
    pub device: String,
    #[serde(rename = "ritmo")]
    pub rate_hz: u32,
    #[serde(rename = "canales")]
    pub channel_count: u16,
    #[serde(rename = "formato")]
    pub format_name: String,
    /// El ritmo que la fuente publicada espera. Si no coincide con `rate_hz`, la
    /// trama viaja diciendo una cosa hacia algo que espera otra.
    #[serde(rename = "ritmoDeLaFuente")]
    pub source_rate: u32,
    #[serde(rename = "coincide")]
    pub matches_rate: bool,
}

/// El micrófono y la cámara elegidos a mano, si alguien eligió.
///
/// Fuera de la sesión y no dentro porque **sobreviven a la llamada**: quien
/// tuvo que corregir el micrófono una vez no debería tener que corregirlo en
/// cada sala.
///
/// El micrófono se guarda por el `DeviceId` de cpal, que la propia biblioteca
/// documenta como estable entre desconexiones y reinicios. La cámara, por
/// nombre, porque `nokhwa` sólo da índice y nombre — y el índice se mueve al
/// enchufar otro cacharro, con lo que la preferencia guardada apuntaría a otra
/// cosa sin que nadie la cambiara.
static CHOSEN_MIC: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
static CHOSEN_CAMERA: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// Un dispositivo, tal como lo enseña la pantalla.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    /// El nombre del sistema, que es también el identificador. Ver arriba.
    pub id: String,
    pub name: String,
    /// El que se está usando ahora mismo.
    pub current: bool,
}

/// Qué micrófonos y qué cámaras hay.
///
/// Se pregunta al abrir el desplegable y no al entrar a la sala: enchufar unos
/// auriculares en mitad de una llamada es exactamente cuando alguien va a
/// abrirlo, y una lista cacheada al entrar no los tendría.
/// Síncrono por dentro pero declarado `async`: enumerar cámaras tarda su
/// décima de segundo, y en un comando síncrono eso es una décima de interfaz
/// congelada. No toca el SDK de LiveKit, así que no le aplica la regla de
/// `voice_set_mic`; se hace por no bloquear la ventana.
#[tauri::command]
pub async fn voice_list_devices() -> Result<serde_json::Value, String> {
    let host = cpal::default_host();
    let chosen = CHOSEN_MIC.lock().unwrap().clone();
    let default_id = host.default_input_device().and_then(|d| id_of(&d));
    let current_mic = chosen.clone().or(default_id);

    let everyone: Vec<DeviceEntry> = host
        .input_devices()
        .map_err(|e| format!("no se pudieron listar los micrófonos: {e}"))?
        .filter_map(|d| {
            let id = id_of(&d)?;
            Some(DeviceEntry {
                current: Some(&id) == current_mic.as_ref(),
                id,
                // En cpal 0.18 el nombre legible es el `Display` del propio
                // dispositivo; `name()` ya no existe.
                name: d.to_string(),
            })
        })
        .collect();
    let mics = clean_devices(everyone);

    let chosen_cam = CHOSEN_CAMERA.lock().unwrap().clone();
    let cameras = usable_cameras();
    let first_frame = cameras.first().map(|c| c.human_name());
    let current_cam = chosen_cam.clone().or(first_frame);
    // Sin repetidas: una webcam suele aparecer dos veces —`/dev/video0` captura
    // y `/dev/video1` metadatos— con el mismo nombre. Salían las dos, y las dos
    // con la marca de «puesta», que además era mentira.
    let cams = dedup(
        cameras
            .into_iter()
            .map(|c| {
                let name = c.human_name();
                DeviceEntry {
                    current: Some(&name) == current_cam.as_ref(),
                    id: name.clone(),
                    name,
                }
            })
            .collect(),
    );

    Ok(serde_json::json!({ "mics": mics, "cams": cams }))
}

/// Cambiar de micrófono o de cámara **sin salirse de la llamada**.
///
/// El micrófono se cambia levantando otra captura y soltando la anterior, en
/// ese orden: la fuente que se publica es la misma, así que para el resto de la
/// sala no pasa nada — no hay que republicar la pista ni se corta el audio más
/// que las milésimas que tarda el dispositivo nuevo en arrancar.
///
/// La cámara sí se apaga y se enciende, porque su pista está atada al
/// dispositivo. Quien esté mirando ve un parpadeo, que es honesto: la cámara
/// que estaba mirando ya no es la que va a ver.
#[tauri::command]
pub async fn voice_set_device(kind: String, device_id: String) -> Result<(), String> {
    match kind.as_str() {
        "mic" => {
            *CHOSEN_MIC.lock().unwrap() = Some(device_id);
            let source_handle = {
                let guard = SESSION.lock().unwrap();
                guard.as_ref().map(|s| s.source_handle.clone())
            };
            // Fuera de una llamada sólo se apunta la preferencia, que es lo que
            // hará falta en la siguiente.
            let Some(source_handle) = source_handle else { return Ok(()) };
            let fresh = start_capture_thread(source_handle)?;
            // Se sustituye **después** de que la nueva arranque: si se soltara
            // antes y la nueva fallara, la llamada se quedaría muda sin que
            // nadie hubiera pedido eso.
            if let Some(s) = SESSION.lock().unwrap().as_mut() {
                s._capture = fresh;
            }
            Ok(())
        }
        "cam" => {
            *CHOSEN_CAMERA.lock().unwrap() = Some(device_id);
            if CAMERA_ON.load(std::sync::atomic::Ordering::Relaxed) {
                voice_set_camera(false).await?;
                voice_set_camera(true).await?;
            }
            Ok(())
        }
        other => Err(format!("no sé cambiar «{other}»")),
    }
}

/// Quita de la lista lo que no es un micrófono para una persona.
///
/// En Linux hace falta porque cpal enumera **la configuración de ALSA entera**:
/// en esta máquina, quince entradas de las que una es hardware. El resto son
/// plugins —conversores de tasa, mezcla a 4/6/8 canales, puentes a JACK y a
/// OSS— con nombres que suenan a dispositivo («Rate Converter Plugin»,
/// «PulseAudio Sound Server») y que a nadie le sirven para elegir su micro.
///
/// Se filtra por el **nombre PCM**, que es lo que `DeviceId::id()` devuelve en
/// ALSA y lo mismo que imprime `arecord -L`. No por la descripción: ésa cambia
/// con el idioma y con la versión, y una lista de textos prohibidos envejece.
///
/// Es una lista de permitidos y no de prohibidos a propósito: los plugins de
/// ALSA se inventan nuevos y el hardware no cambia de forma de nombrarse. El
/// riesgo de un permitido es dejar fuera algo válido, así que **nunca filtra
/// hasta dejarlo vacío**: si no sobrevive nada, se devuelve la lista entera.
/// Una lista fea es mejor que ninguna.
fn clean_devices(everyone: Vec<DeviceEntry>) -> Vec<DeviceEntry> {
    let usable: Vec<DeviceEntry> = everyone.iter().filter(|d| is_usable(&d.id)).cloned().collect();
    dedup(if usable.is_empty() { everyone } else { usable })
}

/// El identificador viene como `<host>:<pcm>`; sólo el `pcm` dice qué es esto.
fn is_usable(id: &str) -> bool {
    let Some((host, pcm)) = id.split_once(':') else {
        return true;
    };
    // Fuera de Linux la enumeración ya viene limpia y no hay nada que decidir.
    if host != "alsa" {
        return true;
    }
    pcm == "default"
        || pcm.starts_with("hw:")
        || pcm.starts_with("plughw:")
        || pcm.starts_with("sysdefault:")
        || pcm.starts_with("front:")
}

/// Un nombre, una entrada.
///
/// El mismo hardware sale varias veces con descripciones idénticas —ocho
/// «sof-hda-dsp,» en esta máquina— porque son subdispositivos del mismo códec.
/// Se queda el primero: si dos cosas se llaman igual, quien elige tampoco puede
/// distinguirlas.
fn dedup(list: Vec<DeviceEntry>) -> Vec<DeviceEntry> {
    let mut seen = std::collections::HashSet::new();
    list
        .into_iter()
        .filter(|d| seen.insert(d.name.clone()))
        .collect()
}

/// Las cámaras que **de verdad** pueden capturar algo.
///
/// Hace falta filtrar porque una webcam suele exponer **dos nodos con el mismo
/// nombre**: el de vídeo y el de metadatos. Medido en esta máquina con el
/// spike `spikes/camera-probe`:
///
/// ```text
/// index=Index(1)  nombre="HD Webcam: HD Webcam"  formatos=0   ← no abre nunca
/// index=Index(0)  nombre="HD Webcam: HD Webcam"  formatos=10  ← 10/10 tramas
/// ```
///
/// Y `nokhwa::query` devuelve **el muerto primero**. Como el selector deduplica
/// por nombre y la preferencia guardada busca por nombre, los dos se quedaban
/// con él: la cámara «se abría» en un nodo que no entrega una sola imagen.
///
/// El criterio es «¿ofrece algún formato?», que es justo lo que los distingue,
/// y no una lista de nombres o de índices sospechosos. Cuesta abrir cada
/// dispositivo un instante; se paga sólo al listar o al elegir, nunca por trama.
fn usable_cameras() -> Vec<nokhwa::utils::CameraInfo> {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{ApiBackend, RequestedFormat, RequestedFormatType};

    nokhwa::query(ApiBackend::Auto)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| {
            nokhwa::Camera::new(
                c.index().clone(),
                RequestedFormat::new::<RgbFormat>(RequestedFormatType::None),
            )
            .and_then(|mut cam| cam.compatible_camera_formats())
            .map(|f| !f.is_empty())
            .unwrap_or(false)
        })
        .collect()
}

/// El identificador estable de un dispositivo de audio, como texto.
fn id_of(d: &cpal::Device) -> Option<String> {
    d.id().ok().map(|i| i.to_string())
}

// ─── El diario del motor ──────────────────────────────────────────────────────

/// Cuántas líneas se guardan. Trescientas cubren de sobra una llamada entera
/// contada por cambios de estado; más sería guardar para nadie.
const DIARY_MAX: usize = 300;

static DIARY: LazyLock<Mutex<std::collections::VecDeque<String>>> =
    LazyLock::new(|| Mutex::new(std::collections::VecDeque::with_capacity(DIARY_MAX)));

/// Apunta algo que pasó en el motor.
///
/// Existe porque **los fallos de aquí abajo no llegan arriba**: la cámara no
/// abría y en la pantalla no pasaba nada, ni imagen ni error, y no había forma
/// de saber dónde había mirado el motor. Tres versiones se probaron a ciegas
/// por eso.
///
/// Se anota en los **cambios de estado**, nunca por trama: entrar, salir,
/// silenciar, qué formato de cámara se pidió y cuál abrió, si el portal
/// concedió la pantalla, qué pistas llegan. Una línea por trama convertiría
/// esto en un cuello de botella y en un diario ilegible.
pub fn note(line: impl AsRef<str>) {
    let line = line.as_ref();
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() % 86_400)
        .unwrap_or(0);
    let stamp = format!("{:02}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60);
    // También a la salida de error: quien tenga la app en una terminal lo ve
    // en vivo, sin abrir ninguna pantalla.
    eprintln!("voz {stamp} · {line}");
    let mut d = DIARY.lock().unwrap();
    if d.len() == DIARY_MAX {
        d.pop_front();
    }
    d.push_back(format!("{stamp} · {line}"));
    drop(d);
    to_file(&format!("{} {stamp} · {line}", t_unix()));
}

fn t_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Dónde se guarda el diario de voz en disco: `voice.log` en la carpeta de datos
/// de la app (en Linux, `~/.local/share/dev.guz-studio.cac/`).
///
/// El diario vivía sólo en memoria y se perdía al cerrar la app. Así, de la
/// llamada que sonó a clics el 15-oct-2026 no quedó nada que leer, y la única
/// prueba fue una nota de voz grabada con el teléfono. En disco, lo que pasó en
/// una llamada se puede leer después, sin que nadie tenga que acordarse de
/// copiarlo a tiempo.
fn diary_path() -> Option<std::path::PathBuf> {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Application Support"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")))
    }?;
    Some(base.join("dev.guz-studio.cac").join("voice.log"))
}

/// Tope del fichero: 2 MB, y el anterior se queda como `voice.log.1`. Las
/// líneas son las del diario (filtradas), no el RTP de libwebrtc: a este
/// ritmo son semanas de llamadas.
const DIARY_FILE_MAX: u64 = 2 * 1024 * 1024;

fn to_file(line: &str) {
    // Las pruebas también anotan, y no escriben en el diario de quien las corre.
    if cfg!(test) {
        return;
    }
    if let Some(path_buf) = diary_path() {
        write_diary(&path_buf, line, DIARY_FILE_MAX);
    }
}

fn write_diary(path_buf: &std::path::Path, line: &str, cap_bytes: u64) {
    use std::io::Write;
    if let Some(dir) = path_buf.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path_buf).map(|m| m.len() > cap_bytes).unwrap_or(false) {
        let _ = std::fs::rename(path_buf, path_buf.with_extension("log.1"));
    }
    // Sin `unwrap`: un disco lleno no puede tumbar una llamada por un log.
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path_buf) {
        let _ = writeln!(f, "{line}");
    }
}

/// Deja que libwebrtc escriba en el diario, filtrado.
///
/// El SDK instala un sumidero de los registros de libwebrtc a nivel `VERBOSE` y
/// los reenvía a `log::debug!(target: "libwebrtc")`. La app no tenía ninguna
/// implementación de `log`, así que esa macro era un no-op: libwebrtc llevaba
/// todo el tiempo contando en voz alta lo que le pasaba —«Failed to create
/// PipeWire stream», «Dropping DMA-BUF modifier», «PipeWire stream state
/// error»— y no había nadie al otro lado.
///
/// **Filtrado y no entero.** A nivel `VERBOSE` esto son miles de líneas por
/// segundo de RTP y estadísticas; volcarlas en un anillo de trescientas borra
/// justo lo que se quiere leer. Pasan sólo las que hablan de la captura de
/// pantalla, que es la superficie donde se pierde la señal hoy.
///
/// Se llama una vez al arrancar. Si otro componente instalara un logger antes,
/// `set_logger` falla y se deja como está: perder trazas es peor que un pánico
/// al arrancar, pero no tanto como no arrancar.
pub fn listen_to_sdk() {
    /// Lo que sí interesa. Todo en minúsculas: la comparación no distingue.
    const RELEVANT: &[&str] = &[
        "pipewire",
        "dma-buf",
        "dmabuf",
        "screencast",
        "portal",
        "modifier",
        "desktop captur",
    ];

    struct DiaryLogger;
    impl log::Log for DiaryLogger {
        fn enabled(&self, record: &log::Metadata) -> bool {
            record.target() == "libwebrtc"
        }

        fn log(&self, record_line: &log::Record) {
            if !self.enabled(record_line.metadata()) {
                return;
            }
            let text = record_line.args().to_string();
            let lowered = text.to_lowercase();
            if !RELEVANT.iter().any(|key| lowered.contains(key)) {
                return;
            }
            // Repetidos seguidos, una sola vez. Un estado de error de PipeWire
            // se reimprime en cada vuelta del bucle: treinta líneas idénticas
            // por segundo llenarían el anillo en diez segundos y se llevarían
            // por delante el resto del diario.
            static LAST_LINE: Mutex<String> = Mutex::new(String::new());
            {
                let mut last_seen = LAST_LINE.lock().unwrap();
                if *last_seen == text {
                    return;
                }
                last_seen.clone_from(&text);
            }
            note(format!("sdk: {text}"));
        }

        fn flush(&self) {}
    }

    static DIARY_LOGGER: DiaryLogger = DiaryLogger;
    if log::set_logger(&DIARY_LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Debug);
    }
}

/// Abrir la cámara y pedir diez tramas, aquí y ahora, sin publicar nada.
///
/// Es el spike `spikes/camera-probe` metido **dentro del proceso de la app**.
/// Nació para dirimir si la cámara se colgaba por el entorno o por nuestro
/// código, y contestó lo que le tocaba: aquí saca 10/10 tramas, luego el
/// entorno estaba limpio y la culpa era nuestra. Lo era —de
/// `NativeVideoSource::new`, no de nokhwa; ver `enter_runtime`—.
///
/// Se queda porque separa dos cosas que desde fuera se ven igual: «esta máquina
/// no da imagen» y «la app no la publica». Lo primero que hay que preguntar
/// cuando alguien reporte pantalla en negro.
///
/// No toca la sesión ni publica pista: se puede pulsar sin estar en una llamada.
///
/// # Contesta siempre, aunque la cámara no
///
/// La primera versión esperaba a que la prueba terminara. Si la cámara se
/// cuelga —que es **el caso que esto existe para detectar**— el botón se
/// quedaba girando y no devolvía nada: el resultado más informativo era el
/// único que no se podía leer. Ahora cada paso se escribe en el diario según
/// ocurre, y el comando se rinde a los quince segundos diciendo dónde se quedó.
/// El hilo colgado se queda ahí —en Rust no se mata desde fuera— pero la
/// evidencia ya está escrita.
#[tauri::command]
pub async fn voice_test_camera() -> Vec<String> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(probe_camera());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(r) => r,
        Err(_) => vec![
            "la prueba no terminó en 15 s: la cámara se quedó colgada".into(),
            "mira el diario de arriba: la última línea «prueba:» dice dónde".into(),
        ],
    }
}

fn probe_camera() -> Vec<String> {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{RequestedFormat, RequestedFormatType, Resolution};

    // Cada paso al diario **según pasa**, no al final: si la cámara se cuelga,
    // lo ya escrito es todo lo que va a haber, y es justo lo que hace falta.
    let mut r = Vec::new();
    let mut points = |line: String| {
        note(format!("prueba: {line}"));
        r.push(line);
    };
    {
        if CAPTURE_ALIVE.load(std::sync::atomic::Ordering::Relaxed) {
            points("hay una captura sin terminar: apaga la cámara antes de probar".into());
            return r;
        }

        points("enumerando cámaras".into());
        let usable = usable_cameras();
        points(format!("cámaras que capturan: {}", usable.len()));
        let Some(info) = usable.first() else {
            return r;
        };
        points(format!(
            "abriendo {:?} ({})",
            info.index(),
            info.human_name()
        ));

        let request = RequestedFormat::new::<RgbFormat>(RequestedFormatType::HighestResolution(
            Resolution::new(VIDEO_WIDTH, VIDEO_HEIGHT),
        ));
        let mut cam = match nokhwa::Camera::new(info.index().clone(), request) {
            Ok(c) => c,
            Err(e) => {
                points(format!("no abre: {e}"));
                return r;
            }
        };
        points(format!("abre como {}", cam.camera_format()));
        if let Err(e) = cam.open_stream() {
            points(format!("open_stream falla: {e}"));
            return r;
        }
        points("open_stream ok, pidiendo la trama 0".into());

        // Diez tramas, con el tiempo de cada una. Si la primera no vuelve, esta
        // línea es la última del informe — y eso ya es la respuesta.
        let mut good = 0;
        for i in 0..10 {
            let t = std::time::Instant::now();
            match cam.frame() {
                Ok(rtc_frame) => {
                    let raw_frames = rtc_frame.buffer().len();
                    if i == 0 {
                        points(format!("trama 0 cruda: {raw_frames} bytes, descodificando"));
                    }
                    match rtc_frame.decode_image::<RgbFormat>() {
                        Ok(rgb) => {
                            good += 1;
                            if i < 2 {
                                points(format!(
                                    "trama {i}: {}x{} en {:?}",
                                    rgb.width(),
                                    rgb.height(),
                                    t.elapsed()
                                ));
                            }
                        }
                        Err(e) => points(format!("trama {i}: no descodifica ({e})")),
                    }
                }
                Err(e) => points(format!("trama {i}: sin trama tras {:?} ({e})", t.elapsed())),
            }
        }
        points(format!("{good}/10 tramas buenas"));
        let _ = cam.stop_stream();
    }
    r
}

/// El diario, lo más reciente al final.
///
/// `async` porque lo exige la regla de `voice_set_mic` — y aunque éste no toca
/// el SDK, la excepción hay que escribirla a mano y no vale la pena.
/// Todo lo que el motor sabe de tu audio, en una sola llamada.
///
/// Existe por un caso concreto: alguien no se oía, oía a los demás
/// perfectamente, y **no había forma de saber por qué**. Se sabía el síntoma y
/// nada más. Las tres causas posibles —el micrófono no entrega muestras, las
/// entrega en silencio, o lo capturado no llega a publicarse— dan exactamente
/// el mismo síntoma visto desde fuera, y ninguna dejaba rastro.
///
/// Los tres campos que las separan son `peak_permille`, `tramas_publicadas` y
/// `publicando`:
///
/// - pico a 0 con tramas subiendo → captura, pero **entrega silencio**.
/// - tramas quietas y `publicando` en falso → capturó y **dejó de publicar**.
/// - pico con señal y tramas subiendo → sube de verdad, y el problema está en
///   el servidor o en el oído del otro.
///
/// Y `formato_entrada.matches_rate` en falso es el desajuste de ritmo, que se traga
/// la voz entera sin dar ni un error.
/// Hasta cuándo sigue abierta la prueba del micrófono, en milisegundos de reloj.
///
/// El medidor se pide mientras el panel está abierto y **se renueva en cada
/// lectura**. Así no hace falta un comando de parar: si la pantalla se cierra,
/// se cambia de sección o la ventana muere, nadie renueva y el flujo se cierra
/// solo. Un «parar» que hay que acordarse de llamar es un micrófono abierto
/// olvidado, y eso es una luz encendida en la cámara de alguien.
static MIC_TEST_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static MIC_TEST_ALIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static MIC_TEST_PEAK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static MIC_TEST_FORMAT: LazyLock<Mutex<Option<InputFormat>>> =
    LazyLock::new(|| Mutex::new(None));
static MIC_TEST_ERROR: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Cuánto vive la prueba sin que nadie vuelva a preguntar.
const MIC_TEST_GRACE_MS: u64 = 1_500;

/// El nivel que entra por el micrófono, ahora mismo.
///
/// Contesta la pregunta que hoy sólo se puede responder llamando a alguien y
/// preguntándole si se te oye — o sea, después de haberle hecho perder el rato.
///
/// **Durante una llamada no abre nada.** La captura ya está midiendo el pico de
/// cada trama, y sobre las muestras que de verdad se envían, que es un dato
/// mejor: abrir un segundo flujo sobre el mismo dispositivo puede fallar en
/// algunos sistemas y, donde no falla, mediría una señal distinta de la que
/// viaja. Fuera de la llamada sí se abre uno de prueba, que se apaga solo.
#[tauri::command]
pub async fn voice_mic_level() -> serde_json::Value {
    // En llamada: lo que ya se está midiendo, y el formato real con el que se
    // abrió — que no es el que dice el desplegable, y esa diferencia fue media
    // investigación del fallo de «no se me oye».
    if PUBLISHING.load(std::sync::atomic::Ordering::Relaxed) {
        return serde_json::json!({
            "enLlamada": true,
            "picoMilesimas": PEAK_PERMILLE.load(std::sync::atomic::Ordering::Relaxed),
            "formatoEntrada": INPUT_FORMAT.lock().unwrap().clone(),
            "error": LAST_CAPTURE_ERROR.lock().unwrap().clone(),
        });
    }

    MIC_TEST_UNTIL.store(now_ms() + MIC_TEST_GRACE_MS, std::sync::atomic::Ordering::Relaxed);
    if !MIC_TEST_ALIVE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        std::thread::spawn(|| {
            if let Err(e) = measure_microphone() {
                *MIC_TEST_ERROR.lock().unwrap() = Some(e);
            }
            MIC_TEST_ALIVE.store(false, std::sync::atomic::Ordering::SeqCst);
            MIC_TEST_PEAK.store(0, std::sync::atomic::Ordering::Relaxed);
        });
    }
    serde_json::json!({
        "enLlamada": false,
        "picoMilesimas": MIC_TEST_PEAK.load(std::sync::atomic::Ordering::Relaxed),
        "formatoEntrada": MIC_TEST_FORMAT.lock().unwrap().clone(),
        "error": MIC_TEST_ERROR.lock().unwrap().clone(),
    })
}

/// Abre el micrófono elegido y va dejando el pico hasta que nadie renueva.
///
/// La elección es **la misma** que hace la llamada —el de a mano si sigue
/// existiendo, y si no el del sistema— y eso es el punto: un medidor que
/// probara otro dispositivo diría que todo está bien mientras la llamada abre
/// uno que no funciona.
fn measure_microphone() -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    *MIC_TEST_ERROR.lock().unwrap() = None;
    let host = cpal::default_host();
    let chosen = CHOSEN_MIC.lock().unwrap().clone();
    let device = chosen
        .and_then(|id| {
            host.input_devices()
                .ok()?
                .find(|d| id_of(d).as_ref() == Some(&id))
        })
        .or_else(|| host.default_input_device())
        .ok_or_else(|| "no hay ningún micrófono".to_string())?;

    let config = device
        .default_input_config()
        .map_err(|e| format!("el micrófono no dice su formato: {e}"))?;
    let rate_hz = config.sample_rate();
    *MIC_TEST_FORMAT.lock().unwrap() = Some(InputFormat {
        device: device.to_string(),
        rate_hz,
        channel_count: config.channels(),
        format_name: format!("{:?}", config.sample_format()),
        source_rate: SAMPLE_RATE,
        matches_rate: rate_hz == SAMPLE_RATE,
    });

    let stream = device
        .build_input_stream(
            config.config(),
            move |samples: &[f32], _: &cpal::InputCallbackInfo| {
                let peak = samples.iter().fold(0.0f32, |m, x| m.max(x.abs()));
                MIC_TEST_PEAK.store(
                    (peak.clamp(0.0, 1.0) * 1000.0) as u32,
                    std::sync::atomic::Ordering::Relaxed,
                );
            },
            |e| {
                *MIC_TEST_ERROR.lock().unwrap() = Some(format!("{e}"));
            },
            None,
        )
        .map_err(|e| format!("no se pudo abrir el micrófono: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("no se pudo arrancar la captura: {e}"))?;

    // Se cierra al dejar de preguntar. Y con un tope duro además del margen: si
    // algo dejara la fecha corriéndose para siempre, el micrófono seguiría
    // abierto para siempre.
    let limit = now_ms() + 60_000;
    while now_ms() < MIC_TEST_UNTIL.load(std::sync::atomic::Ordering::Relaxed)
        && now_ms() < limit
    {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_report() -> serde_json::Value {
    let format_name = INPUT_FORMAT.lock().unwrap().clone();
    let session_alive = SESSION.lock().unwrap().is_some();
    serde_json::json!({
        "sesionViva": session_alive,
        "yo": ME.lock().unwrap().clone(),
        "silenciado": MUTED.load(std::sync::atomic::Ordering::Relaxed),
        "sordo": DEAFENED.load(std::sync::atomic::Ordering::Relaxed),
        "camara": CAMERA_ON.load(std::sync::atomic::Ordering::Relaxed),
        "compartiendo": SHARING.load(std::sync::atomic::Ordering::Relaxed),
        "publicando": PUBLISHING.load(std::sync::atomic::Ordering::Relaxed),
        "tramasPublicadas": FRAMES_PUBLISHED.load(std::sync::atomic::Ordering::Relaxed),
        "picoMilesimas": PEAK_PERMILLE.load(std::sync::atomic::Ordering::Relaxed),
        "ultimoFalloCaptura": LAST_CAPTURE_ERROR.lock().unwrap().clone(),
        "formatoEntrada": format_name,
        "micElegido": CHOSEN_MIC.lock().unwrap().clone(),
        // El diario entero: es lo que cuenta la historia de cómo se llegó aquí.
        "diario": DIARY.lock().unwrap().iter().cloned().collect::<Vec<_>>(),
    })
}

/// Alguien de la sala, reducido a lo que una pantalla recién llegada necesita.
pub struct RemotePeer {
    pub identity: String,
    pub name: String,
    pub speaking_flag: bool,
    /// `None` si todavía no ha publicado micrófono: no se sabe si está abierto,
    /// y la pantalla no debe afirmar ni una cosa ni la otra.
    pub silent: Option<bool>,
    /// Los vídeos suyos **a los que estamos suscritos**. Sólo esos: de uno sin
    /// suscribir no llega ninguna trama, y anunciarlo pondría un lienzo negro
    /// donde tendría que estar su cara.
    pub videos: Vec<crate::video_frames::Fuente>,
}

/// Todo lo que una pantalla nueva tiene que oír para pintar la sala tal como
/// está, en el orden en que lo oiría si hubiera estado desde el principio.
///
/// Es el mismo estado de partida que manda `RoomEvent::Connected` al entrar,
/// más lo que ha ido cambiando desde entonces: quién habla y si se graba. Pura
/// y aparte de la sala para poder probarla.
pub fn snapshot(me: &str, remotes: &[RemotePeer], metadata: &str) -> Vec<VoiceEvent> {
    let mut evs = vec![VoiceEvent::Connected {
        identity: me.to_string(),
    }];
    for r in remotes {
        evs.push(VoiceEvent::Joined {
            identity: r.identity.clone(),
            name: r.name.clone(),
        });
        if let Some(muted) = r.silent {
            evs.push(VoiceEvent::Muted {
                identity: r.identity.clone(),
                muted,
            });
        }
        for f in &r.videos {
            evs.push(VoiceEvent::Video {
                identity: r.identity.clone(),
                source: f.como_texto().into(),
                enabled: true,
            });
        }
    }
    evs.push(VoiceEvent::Speaking {
        identities: remotes
            .iter()
            .filter(|r| r.speaking_flag)
            .map(|r| r.identity.clone())
            .collect(),
    });
    evs.push(recording_event(metadata));
    evs
}

/// Engancharse a la llamada que ya está en curso.
///
/// Es lo que hace una página recién recargada. La sala no se enteró de la
/// recarga —vive en este proceso—, así que no hay nada que reconectar: sólo
/// hace falta que los eventos vayan a la página nueva y que ésta sepa cómo está
/// la sala ahora mismo. Devuelve `None` si no hay llamada; si la hay, de qué es
/// (`meta`) y cómo están tus botones, que la sala no cuenta.
///
/// La instantánea se lee y se manda **con `CHANNEL` tomado**: un evento que se
/// produzca mientras tanto espera en `emit` y sale después, por el canal
/// nuevo. Así no puede colarse un «se fue» entre el «está» de la instantánea y
/// dejar a alguien pintado para siempre.
#[tauri::command]
pub async fn voice_attach(
    on_event: Channel<VoiceEvent>,
) -> Result<Option<serde_json::Value>, String> {
    // Una recarga en mitad de `voice_join`: se espera a que acabe, con tope.
    let limit = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while JOINING.load(std::sync::atomic::Ordering::Relaxed) && std::time::Instant::now() < limit {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    let Some(room) = SESSION.lock().unwrap().as_ref().map(|s| s.room.clone()) else {
        return Ok(None);
    };
    let me = ME.lock().unwrap().clone().unwrap_or_default();

    {
        let mut chan = CHANNEL.lock().unwrap();
        let remotes: Vec<RemotePeer> = room
            .remote_participants()
            .values()
            .map(|p| {
                let pubs = p.track_publications();
                RemotePeer {
                    identity: p.identity().to_string(),
                    name: p.name(),
                    speaking_flag: p.is_speaking(),
                    silent: pubs
                        .values()
                        .find(|x| x.kind() == TrackKind::Audio)
                        .map(|x| x.is_muted()),
                    videos: pubs
                        .values()
                        .filter(|x| x.kind() == TrackKind::Video && x.is_subscribed())
                        .map(|x| source_of(x.source()))
                        .collect(),
                }
            })
            .collect();
        for ev in snapshot(&me, &remotes, &room.metadata()) {
            let _ = on_event.send(ev);
        }
        *chan = Some(on_event);
    }
    note(format!("sala: una pantalla nueva se enganchó como {me}"));

    use std::sync::atomic::Ordering::Relaxed;
    Ok(Some(serde_json::json!({
        "meta": META.lock().unwrap().clone(),
        "yo": me,
        "silenciado": MUTED.load(Relaxed),
        "sordo": DEAFENED.load(Relaxed),
        "camara": CAMERA_ON.load(Relaxed),
        "compartiendo": SHARING.load(Relaxed),
    })))
}

#[tauri::command]
pub async fn voice_diagnostics() -> Vec<String> {
    DIARY.lock().unwrap().iter().cloned().collect()
}

/// Mi propia identidad en la sala.
///
/// Hace falta para **verte a ti mismo**. El motor no se suscribe a sus propias
/// pistas —el SFU no te devuelve lo que acabas de mandar, y menos mal— así que
/// tu cámara y tu pantalla no llegarían nunca por el camino de los demás. Se
/// guardan aquí, en el mismo sitio, para que la interfaz las pida igual.
///
/// Sin esto, encender la cámara con nadie más en la sala no enseña nada, y no
/// hay forma de comprobar que compartir pantalla funciona sin dos máquinas.
static ME: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// El canal de eventos de la sesión en curso, para poder rearrancar la captura
/// sin que el llamante tenga que pasarlo.
///
/// **Es el único canal.** Ningún bucle guarda el suyo: todos mandan por
/// `emit`, que lee éste cada vez. La razón es la recarga del webview: la
/// sala sobrevive —vive en este proceso, no en la página— y la página nueva
/// se engancha con `voice_attach`, que cambia lo que hay aquí. Un bucle con su
/// propia copia seguiría hablándole a una página que ya no existe, y el de la
/// captura, además, se rendía al primer envío fallido y **dejaba de mandar tu
/// voz**. Lo fija `no_loop_keeps_its_own_channel`.
static CHANNEL: LazyLock<Mutex<Option<Channel<VoiceEvent>>>> = LazyLock::new(|| Mutex::new(None));

/// De qué es la llamada, tal como lo dijo la pantalla al entrar
/// (`{spaceId, orgId, spaceName}`).
///
/// Rust no lo lee: lo guarda y lo devuelve. Es lo que una página recién
/// recargada no tiene forma de saber por su cuenta —el SFU sabe la sala, no el
/// canal ni la organización—, y sin ello no podría ni decir dónde estás.
static META: LazyLock<Mutex<Option<serde_json::Value>>> = LazyLock::new(|| Mutex::new(None));

/// Hay un `voice_join` a medias. Una recarga justo mientras conecta tiene que
/// esperar a que termine antes de preguntar si hay sesión: si no, contestaría
/// «no hay» y la conexión acabaría un segundo después, sin nadie que la pinte.
static JOINING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Manda un evento a la pantalla que esté mirando ahora.
///
/// El error se ignora a propósito. Si la página se recargó, el envío falla (o
/// cae en un callback que ya no existe) hasta que la nueva se enganche, y eso
/// no es motivo para que nadie deje de hacer su trabajo: los bucles acaban
/// cuando acaba lo que escuchan, no cuando la pantalla se va.
fn emit(ev: VoiceEvent) {
    let chan = CHANNEL.lock().unwrap().clone();
    if let Some(chan) = chan {
        let _ = chan.send(ev);
    }
}

/// Sordera: lo que llega se descarta al pintarlo en el altavoz.
///
/// Se apaga aquí y no cerrando los streams de reproducción porque las pistas de
/// los demás siguen llegando mientras tanto: si se cerraran, quitar la sordera
/// exigiría reconstruir un stream por persona y los primeros segundos se
/// perderían. Un booleano en el callback cuesta nada y vuelve al instante.
static DEAFENED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Dejar de oír. Silenciar el micrófono es cosa del que llama —ver el store—,
/// porque es una regla del producto y no del motor.
///
/// Síncrono a propósito y es de los pocos que puede serlo: escribe un booleano
/// atómico y nada más. No toca el SDK, así que no le aplica la regla de
/// `voice_set_mic`. Está en la lista de excepciones del test de abajo.
#[tauri::command]
pub fn voice_set_deaf(enabled: bool) -> Result<(), String> {
    DEAFENED.store(enabled, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Al cerrar la ventana. Sin esto queda una sala abierta y un micrófono vivo en
/// un proceso que ya nadie mira — la misma lección que el pty.
pub fn close_all() {
    // Igual que al colgar: sin esto la ventana se cierra y los hilos de la
    // cámara y la pantalla siguen vivos en un proceso que ya nadie mira.
    use std::sync::atomic::Ordering::Relaxed;
    CAMERA_ON.store(false, Relaxed);
    SCREEN_ON.store(false, Relaxed);
    *META.lock().unwrap() = None;
    let session = SESSION.lock().unwrap().take();
    if let Some(s) = session {
        tauri::async_runtime::spawn(async move {
            let _ = s.room.close().await;
        });
    }
    close_output();
}

/// Pedir el micrófono **una vez**, y saber la respuesta, antes de abrirlo.
///
/// Sin esto, en macOS el aviso lo dispara cpal al abrir el dispositivo, y cada
/// apertura que llega con el permiso sin decidir vuelve a preguntar: en un Mac
/// salían seis avisos seguidos al entrar a una llamada. Y un «no» se quedaba
/// en un micrófono que entrega ceros sin explicar por qué.
///
/// Denegado devuelve `voice-mic-denied`, que la app traduce a dónde se
/// arregla. En Linux y Windows no hay nada que pedir.
#[cfg(target_os = "macos")]
fn microphone_permission() -> Result<(), String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use std::sync::mpsc;
    use std::time::Duration;

    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return Ok(());
    };
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
    if status == AVAuthorizationStatus::Authorized {
        return Ok(());
    }
    if status == AVAuthorizationStatus::Denied || status == AVAuthorizationStatus::Restricted {
        note("micro: permiso denegado en el sistema");
        return Err("voice-mic-denied".into());
    }
    note("micro: pidiendo permiso al sistema");
    let (tx, rx) = mpsc::channel::<bool>();
    let answer = RcBlock::new(move |granted: Bool| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &answer) };
    // Dos minutos: lo que tarda alguien en leer el aviso y decidir. Sin
    // respuesta, se trata como un no, que es lo que el sistema hará también.
    match rx.recv_timeout(Duration::from_secs(120)) {
        Ok(true) => Ok(()),
        _ => {
            note("micro: permiso no concedido");
            Err("voice-mic-denied".into())
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn microphone_permission() -> Result<(), String> {
    Ok(())
}

/// El micrófono del sistema, en su propio hilo.
///
/// cpal entrega tramas del tamaño que le da la gana; libwebrtc las quiere de
/// 10 ms exactos. El acumulador de aquí en medio es lo que traduce entre las dos
/// cosas, y sin él la voz sale troceada.
fn start_capture_thread(source_handle: NativeAudioSource) -> Result<StreamGuard, String> {
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        let host = cpal::default_host();
        // El elegido a mano si lo hay y sigue existiendo; si se desenchufó, el
        // del sistema. Caer al del sistema es mejor que negarse a hablar.
        let chosen = CHOSEN_MIC.lock().unwrap().clone();
        let device = chosen
            .and_then(|id| {
                host.input_devices()
                    .ok()?
                    .find(|d| id_of(d).as_ref() == Some(&id))
            })
            .or_else(|| host.default_input_device());
        let device = match device {
            Some(d) => d,
            None => {
                let _ = ready_tx.send(Err("voice-no-mic".into()));
                return;
            }
        };
        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("el micrófono no dice su formato: {e}")));
                return;
            }
        };
        let input_rate = config.sample_rate();
        let input_channels = config.channels() as usize;

        // Qué micrófono se abrió y con qué. Esto no se escribía en ninguna
        // parte, y es la primera pregunta de cualquier diagnóstico: que en
        // Discord funcione no dice qué dispositivo abrió cac.
        // En cpal 0.18 el nombre legible es el `Display`; `name()` no existe.
        let device_name = device.to_string();
        let matches_rate = input_rate == SAMPLE_RATE;
        note(format!(
            "micro: «{device_name}» a {} Hz, {} canal(es), {:?}",
            input_rate,
            config.channels(),
            config.sample_format()
        ));
        if !matches_rate {
            // El desajuste que se traga la voz entera. La fuente publicada se
            // creó a `SAMPLE_RATE` fijo y aquí se está capturando a otro ritmo
            // **sin resamplear**: la trama viaja declarando un ritmo hacia algo
            // que espera otro. Se anota bien fuerte porque el síntoma —nadie te
            // oye, ningún error— no se parece en nada a la causa.
            note(format!(
                "micro: ¡OJO! el dispositivo va a {} Hz y la fuente publicada espera {} Hz, y no hay resampleo",
                input_rate, SAMPLE_RATE
            ));
        }
        *INPUT_FORMAT.lock().unwrap() = Some(InputFormat {
            device: device_name,
            rate_hz: input_rate,
            channel_count: config.channels(),
            format_name: format!("{:?}", config.sample_format()),
            source_rate: SAMPLE_RATE,
            matches_rate,
        });

        let (frames_tx, mut frames_rx) = mpsc::unbounded_channel::<Vec<i16>>();
        let mut accumulator: Vec<i16> = Vec::with_capacity(SAMPLES_PER_FRAME * 2);
        // El acumulador guarda muestras **ya remuestreadas a `SAMPLE_RATE`**,
        // así que una trama de `SAMPLES_PER_FRAME` son siempre 10 ms de los que
        // la fuente espera, venga el dispositivo al ritmo que venga.
        let mut phase = Phase::default();

        let stream = device.build_input_stream(
            config.config(),
            move |samples: &[f32], _: &cpal::InputCallbackInfo| {
                // A mono, promediando: publicar sólo el canal izquierdo pierde
                // la mitad de la señal en micrófonos estéreo.
                // A mono, promediando: publicar sólo el canal izquierdo pierde
                // la mitad de la señal en micrófonos estéreo.
                //
                // Y **al ritmo de la fuente**, que es lo que faltaba. La fuente
                // se crea a `SAMPLE_RATE` fijo y el dispositivo entrega al suyo;
                // sin esto, un micrófono a 44 100 Hz —lo normal en Windows 10 con
                // auriculares USB— hacía que el SDK rechazara la primera trama
                // con «sample_rate and num_channels don't match» y se dejara de
                // publicar **en silencio**: capturabas bien y no te oía nadie.
                //
                // Interpolación lineal y no un remuestreador de verdad: esto es
                // voz camino de Opus, que va a recodificarla entera. El aliasing
                // que introduce queda por debajo de lo que el códec ya hace, y a
                // cambio no entra una dependencia ni trabajo de más en el
                // callback de audio, donde tardar es un corte.
                let silent = MUTED.load(std::sync::atomic::Ordering::Relaxed);
                let mono_frames: Vec<f32> = samples
                    .chunks(input_channels)
                    .map(|t| t.iter().sum::<f32>() / t.len() as f32)
                    .collect();
                resample(
                    &mono_frames,
                    input_rate as f32 / SAMPLE_RATE as f32,
                    &mut phase,
                    silent,
                    &mut accumulator,
                );
                while accumulator.len() >= SAMPLES_PER_FRAME {
                    let rest = accumulator.split_off(SAMPLES_PER_FRAME);
                    let rtc_frame = std::mem::replace(&mut accumulator, rest);
                    // El pico se mide en la tarea, después del procesado: ver
                    // `peak_permille`.
                    let _ = frames_tx.send(rtc_frame);
                }
            },
            // Al diario y guardado, no a un `eprintln!`. En una app empaquetada
            // de Windows stderr no va a ninguna parte: si el flujo se rompe a
            // mitad —que es lo que pasa cuando el sistema retira el
            // dispositivo— el fallo se perdía entero.
            |e| {
                let line = format!("{e}");
                note(format!("micro: el flujo de captura falló: {line}"));
                *LAST_CAPTURE_ERROR.lock().unwrap() = Some(line);
            },
            None,
        );
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("no se pudo abrir el micrófono: {e}")));
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = ready_tx.send(Err(format!("no se pudo arrancar el micrófono: {e}")));
            return;
        }
        let _ = ready_tx.send(Ok(()));

        // El puente al SDK vive en el runtime de tauri; este hilo sólo espera la
        // orden de morir, que es lo que mantiene vivo al `stream` de cpal.
        tauri::async_runtime::spawn(async move {
            // ¿Estás hablando? Se mide aquí, sobre las mismas muestras que se
            // publican, en vez de esperar a que el servidor lo diga: es
            // inmediato, funciona aunque estés solo en la sala, y no depende de
            // cómo esté configurado el observador de niveles del SFU.
            let mut speaking_flag = false;
            let mut last_voice = std::time::Instant::now();
            PUBLISHING.store(true, std::sync::atomic::Ordering::Relaxed);

            let mut processor = Processor::new();
            while let Some(mut samples) = frames_rx.recv().await {
                // Primero el procesado, y todo lo demás detrás: el medidor y
                // el «estás hablando» miran lo que de verdad se manda. Medido
                // antes, el ventilador encendía el aro de hablar.
                if let Err(e) = processor.process_frame(
                    NOISE_SUPPRESSION.load(std::sync::atomic::Ordering::Relaxed),
                    &mut samples,
                    take_reference(),
                ) {
                    note(format!("micro: trama sin procesar: {e}"));
                }
                // El pico, sobre las muestras que **de verdad** se envían.
                // Medirlo antes del silenciado diría que hay señal mientras se
                // publican ceros, que es la mentira más cara aquí.
                PEAK_PERMILLE.store(peak_permille(&samples), std::sync::atomic::Ordering::Relaxed);
                if has_voice(&samples) {
                    last_voice = std::time::Instant::now();
                }
                // La cola es lo que evita el parpadeo entre sílabas.
                let speaking_now = speaking_at(&samples, last_voice);
                if speaking_now != speaking_flag {
                    speaking_flag = speaking_now;
                    // Sin `break` si no hay quien escuche: esto es el bucle
                    // que publica tu voz, y una página recargada no es motivo
                    // para dejar de mandarla. Ver `CHANNEL`.
                    emit(VoiceEvent::SelfSpeaking { speaking: speaking_now });
                }

                let rtc_frame = AudioFrame {
                    data: samples.into(),
                    // `SAMPLE_RATE` y no el del dispositivo: lo que va en `data`
                    // ya viene remuestreado, y declarar el del dispositivo es
                    // exactamente lo que rompía.
                    sample_rate: SAMPLE_RATE,
                    num_channels: 1,
                    samples_per_channel: SAMPLES_PER_FRAME as u32,
                };
                // Antes esto era `if …is_err() { break; }` a secas: el SDK
                // rechazaba la trama, el bucle se salía **sin decir nada**, y
                // desde fuera todo seguía igual —micrófono abierto, pista
                // publicada, interfaz intacta— mientras no subía ni un byte.
                if let Err(e) = source_handle.capture_frame(&rtc_frame).await {
                    let line = format!("{e}");
                    note(format!(
                        "micro: el SDK rechazó una trama y se deja de publicar: {line}"
                    ));
                    *LAST_CAPTURE_ERROR.lock().unwrap() = Some(line);
                    break;
                }
                FRAMES_PUBLISHED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            PUBLISHING.store(false, std::sync::atomic::Ordering::Relaxed);
        });

        let _ = stop_rx.recv();
        drop(stream);
    });

    // Con plazo, como todas las demás capturas.
    //
    // Era la única que esperaba sin límite, y eso la convertía en la forma más
    // silenciosa de romper la app: abrir un dispositivo de audio **puede
    // colgarse** —en Windows pasa cuando el sistema está reenumerando los
    // puntos finales— y este `recv()` bloqueaba dentro de `voice_join`. El
    // comando no resolvía nunca, la interfaz se quedaba en «entrando», y su
    // guardia de reentrada la dejaba ahí para siempre: parecías estar en la
    // llamada y no podías volver a ella.
    //
    // Quince segundos porque abrir el micrófono no compite con ningún diálogo
    // del sistema —la cámara en macOS sí, y por eso la suya son veinte.
    match ready_rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(Ok(())) => Ok(StreamGuard(Some(stop_tx))),
        Ok(Err(e)) => Err(e),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("voice-mic-thread-died".into()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            note("micro: quince segundos sin abrir el dispositivo, se abandona");
            Err("voice-mic-timeout".into())
        }
    }
}

/// ¿Hay voz en estos 10 ms?
///
/// Energía media cuadrática sobre la trama. Se usa RMS y no el pico porque el
/// pico lo alcanza cualquier cosa: con el pico, el roce de un dedo en el
/// micrófono enciende el indicador igual que una frase.
///
/// **Lo que RMS no arregla**: un golpe *fuerte* en 10 ms lleva tanta energía
/// como voz, así que un teclazo cerca del micro enciende el punto trescientos
/// milisegundos. Se comprobó midiendo y se acepta — distinguirlo pide mirar
/// varias tramas y su forma, que es un detector de voz de verdad y no cabe
/// aquí. Lo que sí se descarta es todo lo que suena flojo.
///
/// Con las muestras puestas a cero por `MUTED`, esto da cero solo:
/// silenciarse apaga el indicador sin ningún caso especial.
/// Por dónde va el remuestreo entre un bloque y el siguiente.
///
/// Dos cosas y las dos hacen falta. `pos` es la fracción de cuadro pendiente;
/// sin ella la fase se reinicia en cada callback de cpal y sale un clic cada
/// pocos milisegundos. `last_value` es el último cuadro del bloque anterior, y sin
/// él la muestra que cae en la frontera se interpola contra sí misma —un
/// escalón plano— en vez de contra el cuadro que viene: otro codo, más pequeño
/// pero en el mismo sitio, cada vez.
#[derive(Default)]
struct Phase {
    /// Relativa al primer cuadro del bloque actual. Puede ser negativa (en
    /// `[-1, 0)`), que significa «entre el último del anterior y el primero de
    /// éste».
    pos: f32,
    last_value: f32,
}

/// Lleva un bloque de cuadros mono al ritmo de la fuente.
///
/// Aparte y pura porque es la única parte de la captura que se puede probar sin
/// una tarjeta de sonido, y porque lo que hace mal no se ve: se oye. Un fallo
/// aquí no lanza nada — sale voz con clics, o metálica, o con la velocidad
/// cambiada, y para cuando alguien lo describe ya no se sabe de dónde venía.
///
/// La muestra que cae justo en el borde **se aplaza** al bloque siguiente, que
/// es cuando se conoce su vecina. Aplazar una muestra cuesta veinte
/// microsegundos de latencia; inventarla cuesta un codo audible por bloque.
fn resample(mono_frames: &[f32], step: f32, phase: &mut Phase, silent: bool, output: &mut Vec<i16>) {
    let n = mono_frames.len();
    if n == 0 {
        return;
    }
    let mut pos = phase.pos;
    // Hasta `n - 1` y no hasta `n`: la última posición necesita el cuadro que
    // todavía no ha llegado.
    while pos < (n - 1) as f32 {
        let i = pos.floor();
        let frac = pos - i;
        let a = if i < 0.0 {
            phase.last_value
        } else {
            mono_frames[i as usize]
        };
        let b = mono_frames[(i + 1.0) as usize];
        let mean = a + (b - a) * frac;
        output.push(if silent {
            0
        } else {
            (mean.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
        });
        pos += step;
    }
    // Relativa al primer cuadro del bloque que viene, que es el índice `n` de
    // éste. Queda en `[-1, -1 + step)`, y ese `-1` es lo que apunta a `last_value`.
    phase.pos = pos - n as f32;
    phase.last_value = mono_frames[n - 1];
}

/// El pico de una trama, en tanto por mil de la escala completa.
fn peak_permille(frame_samples: &[i16]) -> u32 {
    let peak = frame_samples.iter().map(|m| m.unsigned_abs() as u32).max().unwrap_or(0);
    peak * 1000 / i16::MAX as u32
}

fn has_voice(frame_samples: &[i16]) -> bool {
    if frame_samples.is_empty() {
        return false;
    }
    let total: f64 = frame_samples
        .iter()
        .map(|&m| {
            let v = m as f64;
            v * v
        })
        .sum();
    let rms = (total / frame_samples.len() as f64).sqrt() / i16::MAX as f64;
    rms as f32 > VOICE_THRESHOLD
}

/// El estado con la cola aplicada: hay voz ahora, o la hubo hace poco.
fn speaking_at(frame_samples: &[i16], last_voice: std::time::Instant) -> bool {
    has_voice(frame_samples) || last_voice.elapsed() < VOICE_HANGOVER
}

/// Traduce los eventos de la sala a lo que la pantalla entiende, y reproduce lo
/// que dicen los demás.
fn listen_to_events(mut events: mpsc::UnboundedReceiver<RoomEvent>, room_ref: std::sync::Weak<Room>) {
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = events.recv().await {
            match ev {
                // Los que ya estaban cuando llegaste.
                //
                // El SDK **no** manda `ParticipantConnected` por ellos: vienen
                // en la respuesta de entrada y sólo aparecen aquí. Sin este
                // brazo, entrar a una conversación en curso enseñaba una sala
                // vacía hasta que alguien se movía — que es justo la vez que
                // más importa ver quién hay.
                RoomEvent::Connected {
                    participants_with_tracks,
                } => {
                    for (p, tracks) in participants_with_tracks {
                        let identity = p.identity().to_string();
                        emit(VoiceEvent::Joined {
                            identity: identity.clone(),
                            name: p.name().to_string(),
                        });
                        // Y su micrófono, que también es estado de partida: si
                        // sólo se reportara al cambiar, quien entró mudo se
                        // vería abierto hasta que se le ocurriera hablar.
                        for track_rtc in tracks {
                            if track_rtc.kind() == TrackKind::Audio {
                                emit(VoiceEvent::Muted {
                                    identity: identity.clone(),
                                    muted: track_rtc.is_muted(),
                                });
                            }
                        }
                    }
                    // Y si ya se estaba grabando cuando llegaste.
                    //
                    // Por la misma razón que los participantes y sus micros:
                    // esto es **estado de partida**, y el SDK no manda un
                    // `RoomMetadataChanged` por algo que ya estaba puesto. Sin
                    // este trozo, quien entra a una llamada que se está
                    // grabando no vería el chip hasta que alguien parase y
                    // volviera a empezar — o sea, nunca.
                    if let Some(room_ref) = room_ref.upgrade() {
                        emit(recording_event(&room_ref.metadata()));
                    }
                }
                // Alguien empezó o paró de grabar mientras estabas dentro.
                RoomEvent::RoomMetadataChanged { metadata, .. } => {
                    emit(recording_event(&metadata))
                }
                RoomEvent::ParticipantConnected(p) => emit(VoiceEvent::Joined {
                    identity: p.identity().to_string(),
                    name: p.name().to_string(),
                }),
                RoomEvent::ParticipantDisconnected(p) => {
                    // Su última cara se va con ella: si no, el mosaico
                    // siguiente que reutilice ese hueco enseñaría a quien ya
                    // se fue.
                    crate::video_frames::olvidar_persona(&p.identity().to_string());
                    emit(VoiceEvent::Left {
                        identity: p.identity().to_string(),
                    })
                }
                RoomEvent::ActiveSpeakersChanged { speakers } => emit(VoiceEvent::Speaking {
                    identities: speakers.iter().map(|s| s.identity().to_string()).collect(),
                }),
                RoomEvent::TrackMuted {
                    participant,
                    publication,
                }
                | RoomEvent::TrackUnmuted {
                    participant,
                    publication,
                } => {
                    // El propio también llega por aquí, y se deja pasar: la
                    // pantalla ya lo pintó de forma optimista al pulsar, y esto
                    // es la confirmación de que el servidor se enteró.
                    if publication.kind() == TrackKind::Audio {
                        emit(VoiceEvent::Muted {
                            identity: participant.identity().to_string(),
                            muted: publication.is_muted(),
                        })
                    }
                }
                // Alguien publica un micrófono estando ya dentro —se reconectó,
                // o cambió de dispositivo—: su estado de partida otra vez.
                RoomEvent::TrackPublished {
                    publication,
                    participant,
                } => {
                    if publication.kind() == TrackKind::Audio {
                        emit(VoiceEvent::Muted {
                            identity: participant.identity().to_string(),
                            muted: publication.is_muted(),
                        })
                    }
                }
                RoomEvent::TrackSubscribed {
                    track,
                    publication,
                    participant,
                } => {
                    let identity_of = participant.identity().to_string();
                    match track {
                        RemoteTrack::Audio(audio) => {
                            play_track(audio.rtc_track());
                        }
                        RemoteTrack::Video(video) => {
                            let source_handle = source_of(publication.source());
                            note(format!("llega {} de {identity_of}", source_handle.como_texto()));
                            receive_video(identity_of.clone(), source_handle, video.rtc_track());
                            emit(VoiceEvent::Video {
                                identity: identity_of,
                                source: source_handle.como_texto().into(),
                                enabled: true,
                            })
                        }
                    }
                }
                RoomEvent::TrackUnsubscribed {
                    track,
                    publication,
                    participant,
                } => {
                    if matches!(track, RemoteTrack::Video(_)) {
                        let identity_of = participant.identity().to_string();
                        let source_handle = source_of(publication.source());
                        note(format!("se va {} de {identity_of}", source_handle.como_texto()));
                        crate::video_frames::olvidar(&identity_of, source_handle);
                        emit(VoiceEvent::Video {
                            identity: identity_of,
                            source: source_handle.como_texto().into(),
                            enabled: false,
                        })
                    }
                }
                RoomEvent::Disconnected { reason } => emit(VoiceEvent::Disconnected {
                    reason: format!("{reason:?}"),
                }),
                _ => {}
            }
        }
    });
}

/// Cada cuánto se pregunta el ida y vuelta. Cinco segundos: es un número para
/// mirar de reojo cuando la llamada va rara, no un gráfico.
const LATENCY_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// El ida y vuelta del par de candidatos que se está usando de verdad.
///
/// Hay un `CandidatePair` por cada camino que ICE probó, y casi todos son
/// callejones sin salida con el contador a cero. El que vale es el **nominado**,
/// que es por donde van los paquetes. Coger el primero de la lista, o el mínimo
/// de todos, da un número bonito que no corresponde a nada.
fn rtt_nominado(stats: &[livekit::webrtc::stats::RtcStats]) -> Option<f64> {
    stats.iter().find_map(|s| match s {
        livekit::webrtc::stats::RtcStats::CandidatePair(cp)
            if cp.candidate_pair.nominated && cp.candidate_pair.current_round_trip_time > 0.0 =>
        {
            Some(cp.candidate_pair.current_round_trip_time)
        }
        _ => None,
    })
}

/// La latencia real, sacada de las estadísticas de la conexión.
///
/// `current_round_trip_time` es lo que mide el propio WebRTC con sus consent
/// checks sobre el camino que está usando. No es una estimación nuestra ni un
/// ping a otra cosa, y por eso se puede enseñar en la cabecera.
///
/// La referencia a la sala es **débil** a propósito: cuando `voice_leave` suelta
/// la sesión, este bucle se entera y se muere. Con un `Arc` fuerte seguiría
/// despierto preguntando por una sala que ya nadie tiene.
fn measure_latency(room_ref: std::sync::Weak<Room>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(LATENCY_EVERY).await;
            let Some(room) = room_ref.upgrade() else { break };
            let Ok(stats) = room.get_stats().await else {
                break;
            };

            // El publisher primero: la subida es la mitad que uno controla, y
            // es la que se degrada cuando la queja es «no me oyen bien».
            //
            // Sin par nominado todavía no hay nada que decir. Callarse es mejor
            // que mandar un cero, que en la cabecera se lee como una conexión
            // perfecta justo mientras se está estableciendo.
            let Some(rtt) = rtt_nominado(&stats.publisher_stats)
                .or_else(|| rtt_nominado(&stats.subscriber_stats))
            else {
                continue;
            };
            emit(VoiceEvent::Latency {
                ms: (rtt * 1000.0).round() as u32,
            });
        }
    });
}

/// Lo que enseña otro, guardado para cuando la pantalla lo pida.
///
/// Aquí **no se codifica nada**: se copian los planos y se dejan en el sitio
/// donde el manejador de `cacvideo://` los va a buscar. Comprimir en cuanto
/// llega la trama sería trabajar para tirarlo — el webview pinta a su ritmo, no
/// al de la red, y una cámara cuyo mosaico nadie mira no debe costar CPU.
///
/// `to_i420()` es una conversión y no una copia sólo cuando la trama no venía
/// ya en I420. Con lo que publica cac —y con lo que publica cualquier cliente
/// de LiveKit— viene en I420, así que en la práctica no cuesta nada.
fn receive_video(
    identity_of: String,
    source_handle: crate::video_frames::Fuente,
    track_rtc: livekit::webrtc::prelude::RtcVideoTrack,
) {
    tauri::async_runtime::spawn(async move {
        let mut incoming = NativeVideoStream::new(track_rtc);
        while let Some(rtc_frame) = incoming.next().await {
            let (wide, tall) = (rtc_frame.buffer.width(), rtc_frame.buffer.height());
            crate::video_frames::guardar(&identity_of, source_handle, &rtc_frame.buffer.to_i420(), wide, tall);
        }
        // El stream se acaba cuando la pista se va; el `olvidar` del evento
        // llega por su lado, y repetirlo aquí no hace daño.
        crate::video_frames::olvidar(&identity_of, source_handle);
    });
}

/// Lo que el SFU llama fuente, en nuestros términos.
///
/// Todo lo que no se anuncia como pantalla se trata como cara. Es la caída
/// segura: una fuente desconocida en un mosaico es raro, y en el escenario a
/// pantalla completa taparía la conversación.
fn source_of(source: TrackSource) -> crate::video_frames::Fuente {
    match source {
        TrackSource::Screenshare => crate::video_frames::Fuente::Pantalla,
        _ => crate::video_frames::Fuente::Camara,
    }
}

/// Lo que dice otro, por los altavoces.
///
/// Un stream de cpal por pista remota. Con dos o cinco personas eso son dos o
/// cinco dispositivos de salida abiertos, que el sistema mezcla — más simple y
/// más robusto que mantener un mezclador propio, y a este tamaño de equipo la
/// diferencia no se nota.
fn play_track(track_rtc: livekit::webrtc::prelude::RtcAudioTrack) {
    ensure_output();
    let queue: TrackQueue = Arc::new(Mutex::new(MixTrack::default()));
    TRACKS.lock().unwrap().push(queue.clone());
    std::thread::spawn(move || {
        // A `SAMPLE_RATE` y mono, que es como mezcla la salida: así todas las
        // pistas suman muestra con muestra y la referencia del eco sale al
        // ritmo de la captura sin otro remuestreo.
        let mut incoming = NativeAudioStream::new(track_rtc, SAMPLE_RATE as i32, 1);
        tauri::async_runtime::block_on(async {
            let mut frames: u64 = 0;
            let mut gaps_before = 0;
            while let Some(rtc_frame) = incoming.next().await {
                frames += 1;
                // Cómo llega lo que entrega el SDK, una vez por pista: si el
                // ritmo o los canales no son los pedidos, aquí se ve.
                if frames == 1 {
                    note(format!(
                        "altavoz: pista a {} Hz, {} canal(es), {} muestras por trama",
                        rtc_frame.sample_rate, rtc_frame.num_channels, rtc_frame.samples_per_channel
                    ));
                }
                let frame_samples = to_mono(&rtc_frame.data, rtc_frame.num_channels.max(1) as usize);
                let mut q = queue.lock().unwrap();
                q.push_samples(&frame_samples);
                // Cada 5 s (500 tramas de 10 ms), los huecos de esta pista y
                // cuánto colchón lleva. Cero huecos es lo sano.
                if frames % 500 == 0 {
                    let gaps = q.gaps - gaps_before;
                    gaps_before = q.gaps;
                    let ms = q.queue.len() * 1000 / SAMPLE_RATE as usize;
                    drop(q);
                    if gaps > 0 {
                        note(format!("altavoz: {gaps} hueco(s) en 5 s, cola de {ms} ms"));
                    }
                }
            }
        });
        // La pista terminó (se fue, o se colgó): fuera de la mezcla.
        TRACKS.lock().unwrap().retain(|c| !Arc::ptr_eq(c, &queue));
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
const VIDEO_WIDTH: u32 = 1280;
const VIDEO_HEIGHT: u32 = 720;

/// RGB de la cámara → I420, que es lo que WebRTC transporta.
///
/// A mano y no con los ayudantes del SDK porque los suyos van a NV12 y de ahí a
/// I420: dos conversiones y una copia de más por trama, treinta veces por
/// segundo. Esta es la aritmética de BT.601 y cabe en veinte líneas.
///
/// El submuestreo de croma toma **una** muestra por bloque de 2×2 en vez de
/// promediar los cuatro. Es lo que hace la mayoría de las cámaras al entregar
/// YUY2, y la diferencia no se ve en una cara a 720p.
fn rgb_a_i420(rgb: &[u8], wide: u32, tall: u32, dest: &mut I420Buffer) {
    let (w, h) = (wide as usize, tall as usize);
    let (sy, su, _sv) = dest.strides();
    let (y_plane, u_plane, v_plane) = dest.data_mut();

    for line_out in 0..h {
        for col in 0..w {
            let i = (line_out * w + col) * 3;
            let (r, g, b) = (rgb[i] as f32, rgb[i + 1] as f32, rgb[i + 2] as f32);
            y_plane[line_out * sy as usize + col] =
                (0.257 * r + 0.504 * g + 0.098 * b + 16.0).clamp(0.0, 255.0) as u8;

            // Un píxel de croma por cada cuatro de luma.
            if line_out % 2 == 0 && col % 2 == 0 {
                let idx = (line_out / 2) * su as usize + col / 2;
                u_plane[idx] = (-0.148 * r - 0.291 * g + 0.439 * b + 128.0).clamp(0.0, 255.0) as u8;
                v_plane[idx] = (0.439 * r - 0.368 * g - 0.071 * b + 128.0).clamp(0.0, 255.0) as u8;
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
        let guard = SESSION.lock().unwrap();
        let s = guard.as_ref().ok_or("no estás en ninguna sala")?;
        s.room.clone()
    };

    if !enabled {
        unpublish(&room, TrackSource::Camera).await;
        CAMERA_ON.store(false, std::sync::atomic::Ordering::Relaxed);
        // Y se borra la última trama propia: sin esto, apagar la cámara deja tu
        // cara congelada en tu propio mosaico, que es peor que no verse.
        if let Some(me) = ME.lock().unwrap().clone() {
            crate::video_frames::olvidar(&me, crate::video_frames::Fuente::Camara);
        }
        return Ok(video_state());
    }

    // La fuente se crea **con lo que la cámara entregue**, no con lo que
    // pidamos. Esto era al revés y fue un fallo silencioso: se fijaba 1280×720
    // y el bucle descartaba toda trama de otro tamaño, así que una webcam que
    // entregara 640×480 o 1080p dejaba el botón encendido y la imagen en
    // negro, sin un error en ninguna parte. Se pide algo cercano a 720p y se
    // acepta lo que haya.
    // La bandera **antes** de arrancar: el bucle de captura la mira para saber
    // si sigue vivo, y encenderla después dejaría el hilo saliendo en la
    // primera vuelta, sin entregar nunca una trama. Si algo falla se vuelve a
    // apagar unas líneas más abajo.
    if CAPTURE_ALIVE.load(std::sync::atomic::Ordering::Relaxed) {
        note("cámara: ya hay una captura sin terminar, no se abre otra");
        return Err(
            "la cámara sigue ocupada por el intento anterior. Sal de la llamada y vuelve a entrar"
                .into(),
        );
    }
    CAMERA_ON.store(true, std::sync::atomic::Ordering::Relaxed);
    let (source_handle, wide, tall) = start_camera().inspect_err(|_| {
        CAMERA_ON.store(false, std::sync::atomic::Ordering::Relaxed);
    })?;
    note(format!("cámara: publicada a {wide}x{tall}"));
    let track_rtc = LocalVideoTrack::create_video_track("camara", RtcVideoSource::Native(source_handle));
    room.local_participant()
        .publish_track(
            LocalTrack::Video(track_rtc),
            TrackPublishOptions {
                source: TrackSource::Camera,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| {
            CAMERA_ON.store(false, std::sync::atomic::Ordering::Relaxed);
            format!("no se pudo publicar la cámara: {e}")
        })?;
    Ok(video_state())
}

static CAMERA_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// ¿Queda un hilo de captura del que no se sabe nada?
///
/// `MmapStream::next()` —lo que hay debajo de `Camera::frame()` en Linux—
/// **bloquea sin plazo** y nokhwa no expone ninguno. Si el driver no entrega,
/// ese hilo se queda ahí para siempre reteniendo el dispositivo, y en Rust no
/// se mata un hilo desde fuera. Con esto, el segundo intento dice lo que pasa
/// en vez de añadirse al montón.
///
/// Aviso sobre su alcance, que se aprendió por las malas: esto **protege de un
/// cuelgue, no de una muerte**. El diario de la v1.6.45 enseñaba la cámara
/// abriéndose dos veces seguidas a pesar de la guardia, y la explicación no era
/// que fallara: el hilo moría de un pánico, el desenrollado ejecutaba el `Drop`
/// de `OnExit` y la bandera bajaba correctamente. La guardia hacía su trabajo;
/// la conclusión que sacamos de verla fallar era la equivocada.
static CAPTURE_ALIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SCREEN_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// ¿Hay una pista de pantalla publicada de verdad?
///
/// Separada de `SCREEN_ON` porque esa dice otra cosa —«el hilo de captura está
/// vivo»— y se enciende **antes** de que el sistema conceda nada. Usarla como
/// «estoy compartiendo» convertía el diálogo del portal abierto en un éxito:
/// pulsar el botón otra vez mientras se elegía pantalla devolvía «sí, ya está»,
/// la interfaz encendía el foco y el cartel de «You are sharing», y lo que se
/// veía era un rectángulo negro que nadie iba a rellenar.
static SHARING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Compartir la pantalla.
///
/// # El selector de fuentes lo pinta el sistema, no nosotros
///
/// En Linux la captura pasa por **xdg-desktop-portal**, que enseña su propio
/// diálogo de permiso y de elección; en macOS, por ScreenCaptureKit con su
/// selector. Eso no es una limitación que estemos rodeando: el permiso de
/// grabar tu pantalla no debe concederlo una aplicación dibujando su propia
/// ventana. Por eso este comando no recibe una fuente y no hay un
/// `voice_list_sources`: se pide compartir y el sistema pregunta qué.
///
/// En Windows sí se podría enumerar y elegir en la app —Windows Graphics
/// Capture lo permite—, y ahí queda para cuando alguien lo pida. Un selector
/// propio en un sistema y el del sistema en los otros dos es peor de explicar
/// que un solo camino.
///
/// # Es una pista aparte de la cámara
///
/// `is_screencast: true` no es decorativo: el SFU cambia de estrategia con él
/// —en una cara prioriza la fluidez, en una pantalla el detalle del texto
/// aunque baje la tasa— y el otro extremo lo usa para saber que eso va al
/// escenario y no a un mosaico.
/// Una pantalla que se puede compartir, para el selector de la app.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct ScreenSource {
    /// Como texto: un `u64` no cabe entero en un número de JavaScript.
    pub id: String,
    pub title: String,
}

/// Si en esta sesión elige la pantalla el sistema (el portal de Wayland) y no
/// la app. Ahí la lista del capturador trae una entrada de relleno, y
/// preguntar en la app sería preguntar dos veces.
fn the_system_chooses(session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    session_type == Some("wayland") || wayland_display.is_some_and(|d| !d.is_empty())
}

/// Las pantallas que hay, para preguntar cuál compartir cuando hay más de una.
/// Vacía donde elige el sistema (Wayland): ahí pregunta su propio diálogo.
#[tauri::command]
pub async fn voice_screen_sources() -> Vec<ScreenSource> {
    use livekit::webrtc::desktop_capturer::{DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions};
    if the_system_chooses(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
    ) {
        return vec![];
    }
    // En un hilo de bloqueo del runtime: listar habla con el servidor
    // gráfico, y no tiene que parar ni el hilo principal ni a los demás.
    tauri::async_runtime::spawn_blocking(|| {
        let Some(cap) = DesktopCapturer::new(DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen)) else {
            return vec![];
        };
        cap.get_source_list()
            .iter()
            .map(|f| ScreenSource { id: f.id().to_string(), title: f.title() })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Cuál de las fuentes se comparte: la pedida si está; si no, la primera, que
/// es lo que se hacía siempre (y lo que sigue haciendo Wayland, donde la
/// elección de verdad la hace el portal).
fn source_index(ids: &[String], requested: Option<&str>) -> Option<usize> {
    if ids.is_empty() {
        return None;
    }
    Some(requested.and_then(|p| ids.iter().position(|i| i == p)).unwrap_or(0))
}

#[tauri::command]
pub async fn voice_share_screen(source_id: Option<String>) -> Result<VideoState, String> {
    let room = {
        let guard = SESSION.lock().unwrap();
        match guard.as_ref() {
            Some(s) => s.room.clone(),
            None => return Err("voice-not-in-room".into()),
        }
    };
    if SHARING.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(video_state());
    }
    if SCREEN_ON.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("voice-share-pending".into());
    }

    // La resolución la dicta la pantalla que el sistema conceda, así que la
    // fuente se crea con la de la primera trama. Hasta que llegue no hay nada
    // que publicar — y publicar una pista muerta deja a los demás mirando un
    // rectángulo negro mientras alguien decide en el diálogo del portal.
    let (source_handle, wide, tall) = start_screen(source_id)?;

    let track_rtc = LocalVideoTrack::create_video_track("pantalla", RtcVideoSource::Native(source_handle));
    room.local_participant()
        .publish_track(
            LocalTrack::Video(track_rtc),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| {
            SCREEN_ON.store(false, std::sync::atomic::Ordering::Relaxed);
            format!("no se pudo publicar la pantalla: {e}")
        })?;
    SHARING.store(true, std::sync::atomic::Ordering::Relaxed);
    note(format!("pantalla: publicada a {wide}x{tall}"));
    Ok(video_state())
}

/// Dejar de compartir.
#[tauri::command]
pub async fn voice_stop_share() -> Result<VideoState, String> {
    let room = {
        let guard = SESSION.lock().unwrap();
        match guard.as_ref() {
            Some(s) => s.room.clone(),
            None => return Err("voice-not-in-room".into()),
        }
    };
    // Primero la bandera: es la que para el hilo de captura, y pararlo antes de
    // despublicar evita que siga entregando tramas a una pista que ya no está.
    SCREEN_ON.store(false, std::sync::atomic::Ordering::Relaxed);
    SHARING.store(false, std::sync::atomic::Ordering::Relaxed);
    unpublish(&room, TrackSource::Screenshare).await;
    if let Some(me) = ME.lock().unwrap().clone() {
        crate::video_frames::olvidar(&me, crate::video_frames::Fuente::Pantalla);
    }
    Ok(video_state())
}

/// Cuánto se espera a que alguien conteste al diálogo del sistema.
///
/// Un minuto y no diez segundos: entre que aparece el diálogo, se busca la
/// ventana correcta y se acepta, pasa más tiempo del que parece — y rendirse
/// mientras el usuario está eligiendo es el peor momento posible.
const PORTAL_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Mete el hilo actual en el runtime de Tokio, y por qué hace falta.
///
/// `NativeVideoSource::new` **no es una función de construcción a secas**:
/// dentro arranca un mantenedor de tramas negras con `livekit_runtime::spawn`,
/// que con la característica `tokio` es `tokio::task::spawn` a pelo. Fuera de
/// un runtime eso entra en pánico —«there is no reactor running»— y el hilo
/// muere ahí mismo.
///
/// Lo que se veía: la cámara abría, entregaba su primera trama cruda y el
/// diario se paraba en «descodificando» para siempre. El vigía señalaba esa
/// etapa porque es la última que se marca **antes** de crear la fuente, y
/// `spikes/camera-probe` daba 10/10 tramas con la misma llamada a nokhwa — la
/// diferencia entre los dos era justo esta línea, que el spike no tenía.
///
/// Lo peor era el disimulo. Al desenrollarse el pánico se ejecuta el `Drop` de
/// `OnExit`, que baja `CAPTURE_ALIVE`; así que la guardia contra dos capturas a
/// la vez daba paso libre al siguiente intento y la cámara se abría dos veces.
/// Y el `ready_tx` se cerraba con el hilo, con lo que el llamante recibía un
/// canal desconectado que se contaba como plazo agotado: «la cámara no entregó
/// ninguna imagen», que era verdad y no decía nada.
///
/// La pantalla caía por lo mismo, un piso más abajo: «pidiendo permiso» y
/// después nada.
///
/// Reproducido y comprobado en `spikes/voice-native/src/bin/source_handle.rs`: desde
/// un hilo suelto muere, entrando al runtime **desde ese mismo hilo** funciona.
/// Entrar en `main` no vale — el contexto es por hilo, no por proceso.
fn enter_runtime(
    handle_ref: &tauri::async_runtime::RuntimeHandle,
) -> tokio::runtime::EnterGuard<'_> {
    handle_ref.inner().enter()
}

/// Un contexto de GLib **propio** para el hilo que habla con el portal.
///
/// El capturador de PipeWire pide la sesión a xdg-desktop-portal por D-Bus con
/// GIO, de forma asíncrona. GIO entrega esas respuestas al *thread-default main
/// context* del hilo que hizo la llamada, y sólo cuando alguien lo itera. Un
/// `std::thread` pelado no tiene contexto propio, así que caían en el global
/// —el de GTK— y de ahí no volvían: el diálogo salía, elegías pantalla, y
/// `capture_frame` contestaba `Temporary` para siempre. Mil quinientas veces
/// seguidas, medido en el diario.
///
/// Iterar el contexto global desde aquí habría «funcionado» y es justo lo que
/// no se puede hacer: despacharía fuentes de GTK fuera del hilo principal. Por
/// eso un contexto nuestro, empujado **antes** de crear el capturador —GIO mira
/// cuál hay puesto en el momento de la llamada, no después— e iterado sólo
/// desde este hilo.
///
/// Es también la razón de no encender la característica `glib-main-loop` de
/// `libwebrtc`: hace lo mismo sobre el contexto global. Ver el `Cargo.toml`.
#[cfg(target_os = "linux")]
struct GlibContext(*mut std::ffi::c_void);

#[cfg(target_os = "linux")]
extern "C" {
    fn g_main_context_new() -> *mut std::ffi::c_void;
    fn g_main_context_push_thread_default(context: *mut std::ffi::c_void);
    fn g_main_context_pop_thread_default(context: *mut std::ffi::c_void);
    fn g_main_context_iteration(context: *mut std::ffi::c_void, may_block: i32) -> i32;
    fn g_main_context_unref(context: *mut std::ffi::c_void);
}

#[cfg(target_os = "linux")]
impl GlibContext {
    fn fresh_one() -> Self {
        unsafe {
            let ctx = g_main_context_new();
            g_main_context_push_thread_default(ctx);
            Self(ctx)
        }
    }

    /// Despacha lo que haya pendiente, sin bloquear. Devuelve cuántos.
    ///
    /// La cuenta se lleva al diario porque distingue dos fallos que se ven
    /// igual: cero eventos en toda la espera significa que las respuestas del
    /// portal **no vienen a este contexto** —y entonces esto no es el arreglo—;
    /// unos cuantos y aun así sin imagen es otra cosa, más abajo.
    fn pump(&self) -> u32 {
        // Con tope: si algo reencolara sin parar, un `while` a secas dejaría de
        // pedir tramas para siempre y el cuelgue sería nuestro.
        let mut n = 0;
        unsafe {
            for _ in 0..64 {
                if g_main_context_iteration(self.0, 0) == 0 {
                    break;
                }
                n += 1;
            }
        }
        n
    }
}

#[cfg(target_os = "linux")]
impl Drop for GlibContext {
    fn drop(&mut self) {
        unsafe {
            g_main_context_pop_thread_default(self.0);
            g_main_context_unref(self.0);
        }
    }
}

/// Fuera de Linux no hay portal ni GLib: el capturador es del sistema.
#[cfg(not(target_os = "linux"))]
struct GlibContext;

#[cfg(not(target_os = "linux"))]
impl GlibContext {
    fn fresh_one() -> Self {
        Self
    }
    fn pump(&self) -> u32 {
        0
    }
}

/// La pantalla del sistema, en su propio hilo.
///
/// Devuelve la fuente ya alimentada con la primera trama, más sus medidas. Se
/// espera a esa primera trama a propósito: es lo único que demuestra que el
/// sistema concedió el permiso, y es lo que permite crear la pista con el
/// tamaño de verdad en vez de adivinarlo.
fn start_screen(requested: Option<String>) -> Result<(NativeVideoSource, u32, u32), String> {
    use livekit::webrtc::desktop_capturer::{
        DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
    };

    let (first_tx, first_rx) = std::sync::mpsc::channel::<Result<(u32, u32), String>>();
    let (source_tx, source_rx) = std::sync::mpsc::channel::<NativeVideoSource>();

    let handle_ref = tauri::async_runtime::handle();
    std::thread::spawn(move || {
        // Sin esto la captura no llega a la primera trama.
        let _in_runtime = enter_runtime(&handle_ref);
        // Antes de crear el capturador, no después: GIO se queda con el
        // contexto que encuentre puesto en el momento de la llamada.
        let glib = GlibContext::fresh_one();
        let mut opts = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
        // El cursor dentro de la imagen. Compartir una pantalla para señalar
        // algo sin que se vea el puntero es media función.
        opts.set_include_cursor(true);
        let Some(mut cap) = DesktopCapturer::new(opts) else {
            note("pantalla: este sistema no trae capturador");
            let _ = first_tx.send(Err("voice-no-screen-capture".into()));
            return;
        };
        // En Wayland la lista trae una entrada de relleno y la elección real la
        // hace el portal; en Windows y macOS es la pantalla principal. Elegir
        // aquí una concreta sería adelantarse a lo que el sistema va a preguntar.
        let sources = cap.get_source_list();
        note(format!(
            "pantalla: pidiendo permiso ({} fuentes: {})",
            sources.len(),
            sources
                .iter()
                .map(|f| format!("id={} «{}»", f.id(), f.title()))
                .collect::<Vec<_>>()
                .join(", ")
        ));
        let (sent, received) = std::sync::mpsc::channel();
        // La que se eligió en la app, si hay varias y se eligió (X11, Windows,
        // macOS con dos monitores). Antes era siempre la primera, y con un
        // segundo monitor no había forma de compartir el otro (#117).
        let ids: Vec<String> = sources.iter().map(|f| f.id().to_string()).collect();
        let chosen_cam = source_index(&ids, requested.as_deref()).and_then(|i| sources.get(i).cloned());
        cap.start_capture(chosen_cam, move |r| {
            // Con su stride: en macOS cada fila de la captura trae relleno
            // (filas alineadas, anchos de Retina), y leerla como si midiera
            // `wide × 4` justos corre cada fila un poco más que la anterior:
            // la imagen sale inclinada y rayada, como una tele sin señal
            // (#98). En Linux coinciden y no se notaba.
            let _ = sent.send(r.map(|f| (f.width() as u32, f.height() as u32, f.stride() as usize, f.data().to_vec())));
        });

        // La bandera se baja pase lo que pase, igual que en la cámara. Estaba
        // sólo al final del bucle, y un hilo que muriera antes la dejaba en
        // alto para siempre: la app se creía compartiendo —botón en «Stop
        // sharing», cartel de «You are sharing»— sobre un cuadro negro que
        // nadie iba a rellenar nunca.
        struct OnExit;
        impl Drop for OnExit {
            fn drop(&mut self) {
                SCREEN_ON.store(false, std::sync::atomic::Ordering::Relaxed);
                SHARING.store(false, std::sync::atomic::Ordering::Relaxed);
            }
        }
        SCREEN_ON.store(true, std::sync::atomic::Ordering::Relaxed);
        let _witness = OnExit;
        let limit = std::time::Instant::now() + PORTAL_WAIT;
        let mut source_handle: Option<NativeVideoSource> = None;

        // A ritmo de vídeo, nunca en bucle cerrado: pedir tramas a un millón por
        // segundo no deja trabajar al hilo que tiene que producirlas, y el
        // capturador contesta «todavía no» mientras tanto. Costó una tarde.
        let each = std::time::Duration::from_millis(1000 / 30);
        // Mientras no llega la primera trama, un parte cada cinco segundos.
        //
        // «Aparece el diálogo, eliges, y no pasa nada» se veía exactamente
        // igual con el bucle de GLib apagado que con el usuario pensándoselo, y
        // eso costó una tarde. Con la cuenta de respuestas se distinguen: cero
        // es que nadie está contestando por debajo, muchas y todas `Temporary`
        // es que el sistema aún no ha concedido.
        let mut answers = 0u32;
        let mut failures = 0u32;
        let mut events = 0u32;
        let mut seen_events = 0u32;
        let mut next_part = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while SCREEN_ON.load(std::sync::atomic::Ordering::Relaxed) {
            events += glib.pump();
            // Cada movimiento del contador, con su hora.
            //
            // El saludo con el portal son unos nueve eventos hasta que aparece
            // el diálogo, y luego se para en seco a esperar a una persona. Con
            // el parte cada cinco segundos eso se ve como un número quieto y no
            // se distingue de estar roto. Con la hora de cada movimiento sí: si
            // al elegir pantalla el contador se mueve, la respuesta llegó a
            // nuestro contexto; si no se mueve, llegó a otro sitio.
            if events != seen_events {
                note(format!(
                    "pantalla: glib despachó {} evento(s) más (van {events})",
                    events - seen_events
                ));
                seen_events = events;
            }
            cap.capture_frame();
            let mut last_seen = None;
            while let Ok(r) = received.try_recv() {
                answers += 1;
                if r.is_err() {
                    failures += 1;
                }
                last_seen = Some(r);
            }
            if source_handle.is_none() && std::time::Instant::now() >= next_part {
                note(format!(
                    "pantalla: sin imagen todavía — {answers} respuestas del capturador, \
                     {failures} con error, {events} eventos de glib despachados"
                ));
                next_part += std::time::Duration::from_secs(5);
            }
            match last_seen {
                Some(Ok((w, h, stride, bgra))) => {
                    let fte = source_handle.get_or_insert_with(|| {
                        let f = NativeVideoSource::new(
                            VideoResolution {
                                width: w,
                                height: h,
                            },
                            // Pantalla, no cara: el SFU prioriza el detalle.
                            true,
                        );
                        note(format!("pantalla: concedida, primera trama {w}x{h}"));
                        let _ = source_tx.send(f.clone());
                        let _ = first_tx.send(Ok((w, h)));
                        f
                    });
                    let mut buffer = I420Buffer::new(w, h);
                    if !bgra_to_i420(&bgra, w, h, stride, &mut buffer) {
                        // Una trama que no cabe en lo que dice medir: se salta
                        // en vez de leer fuera de ella.
                        continue;
                    }
                    keep_me(crate::video_frames::Fuente::Pantalla, &buffer, w, h);
                    fte.capture_frame(&VideoFrame {
                        rotation: VideoRotation::VideoRotation0,
                        timestamp_us: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_micros() as i64)
                            .unwrap_or(0),
                        buffer,
                        frame_metadata: Default::default(),
                    });
                }
                Some(Err(e)) => {
                    // `Temporary` es lo normal mientras el sistema pregunta;
                    // `Permanent` es que dijo que no.
                    if format!("{e:?}").contains("Permanent") {
                        note(format!("pantalla: el sistema la denegó ({e:?})"));
                        let _ = first_tx.send(Err("voice-screen-denied".into()));
                        break;
                    }
                }
                None => {}
            }
            if source_handle.is_none() && std::time::Instant::now() > limit {
                note("pantalla: nadie contestó al diálogo en un minuto");
                let _ = first_tx.send(Err("voice-share-unanswered".into()));
                break;
            }
            std::thread::sleep(each);
        }
    });

    match first_rx.recv_timeout(PORTAL_WAIT + std::time::Duration::from_secs(5)) {
        Ok(Ok((w, h))) => {
            let source_handle = source_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .map_err(|_| "la captura arrancó sin fuente".to_string())?;
            Ok((source_handle, w, h))
        }
        Ok(Err(e)) => Err(e),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            note("pantalla: el hilo de captura murió sin decir nada");
            Err("voice-screen-thread-died".into())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("voice-screen-timeout".into()),
    }
}

/// Guarda una trama propia donde la interfaz las busca.
///
/// Cuesta una copia por trama, la misma que se paga por cada participante
/// remoto. Se paga siempre y no sólo cuando alguien mira, porque la alternativa
/// —un «¿hay alguien mirando?» que la captura tuviera que consultar— acopla el
/// hilo del vídeo a la interfaz para ahorrar un memcpy.
fn keep_me(source_handle: crate::video_frames::Fuente, buffer: &I420Buffer, wide: u32, tall: u32) {
    let Some(me) = ME.lock().unwrap().clone() else {
        return;
    };
    crate::video_frames::guardar(&me, source_handle, buffer, wide, tall);
}

/// BGRA de la pantalla → I420.
///
/// El capturador de escritorio entrega **BGRA**, no RGB como la cámara: el
/// orden de los canales es el de los mapas de bits del sistema, y confundirlo
/// pinta a todo el mundo de azul. Misma aritmética BT.601 que `rgb_a_i420`,
/// leyendo los componentes al revés y saltándose el alfa.
///
/// `stride` es lo que mide de verdad cada fila en bytes, relleno incluido; no
/// siempre `wide × 4` (ver `start_screen`). Devuelve false, sin tocar
/// nada, si la trama no cabe en lo que dice medir.
fn bgra_to_i420(bgra: &[u8], wide: u32, tall: u32, stride: usize, dest: &mut I420Buffer) -> bool {
    let (w, h) = (wide as usize, tall as usize);
    if w == 0 || h == 0 || stride < w * 4 || bgra.len() < stride * (h - 1) + w * 4 {
        return false;
    }
    let (sy, su, _sv) = dest.strides();
    let (y_plane, u_plane, v_plane) = dest.data_mut();

    for line_out in 0..h {
        for col in 0..w {
            let i = line_out * stride + col * 4;
            let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
            y_plane[line_out * sy as usize + col] =
                (0.257 * r + 0.504 * g + 0.098 * b + 16.0).clamp(0.0, 255.0) as u8;
        }
    }
    for line_out in (0..h).step_by(2) {
        for col in (0..w).step_by(2) {
            let i = line_out * stride + col * 4;
            let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
            let cf = line_out / 2;
            let cc = col / 2;
            u_plane[cf * su as usize + cc] =
                (-0.148 * r - 0.291 * g + 0.439 * b + 128.0).clamp(0.0, 255.0) as u8;
            v_plane[cf * su as usize + cc] =
                (0.439 * r - 0.368 * g - 0.071 * b + 128.0).clamp(0.0, 255.0) as u8;
        }
    }
    true
}

fn video_state() -> VideoState {
    use std::sync::atomic::Ordering::Relaxed;
    VideoState {
        camera: CAMERA_ON.load(Relaxed),
        screen: SHARING.load(Relaxed),
    }
}

/// Retira la pista de una fuente. Se busca por `source` y no por nombre: el
/// nombre es nuestro y podría cambiar, la fuente es lo que el otro extremo usa
/// para decidir si eso es una cara o una pantalla.
async fn unpublish(room: &Arc<Room>, source_handle: TrackSource) {
    let sids: Vec<_> = room
        .local_participant()
        .track_publications()
        .iter()
        .filter(|(_, pub_)| pub_.source() == source_handle)
        .map(|(sid, _)| sid.clone())
        .collect();
    for sid in sids {
        let _ = room.local_participant().unpublish_track(&sid).await;
    }
}

/// La cámara del sistema, en su propio hilo.
fn start_camera() -> Result<(NativeVideoSource, u32, u32), String> {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{CameraIndex, RequestedFormat, RequestedFormatType, Resolution};
    use nokhwa::Camera;

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(u32, u32), String>>();
    let (source_tx, source_rx) = std::sync::mpsc::channel::<NativeVideoSource>();
    CAPTURE_ALIVE.store(true, std::sync::atomic::Ordering::Relaxed);
    let handle_ref = tauri::async_runtime::handle();
    std::thread::spawn(move || {
        // Sin esto la captura no llega a la primera trama.
        let _in_runtime = enter_runtime(&handle_ref);
        // Se baja pase lo que pase —incluido un pánico, que desenrolla y ejecuta
        // este `Drop`—, salvo si el hilo se queda colgado dentro de una llamada
        // que no vuelve, que es el caso que el testigo existe para detectar.
        struct OnExit;
        impl Drop for OnExit {
            fn drop(&mut self) {
                CAPTURE_ALIVE.store(false, std::sync::atomic::Ordering::Relaxed);
            }
        }
        let _witness = OnExit;

        // Lo que se le pide a la cámara, en orden de preferencia y **cayendo**
        // al siguiente si no lo tiene.
        //
        // Hace falta la cadena porque `HighestResolution` de nokhwa **exige la
        // resolución exacta**: filtra por igualdad y devuelve `None` si no la
        // encuentra, con lo que `Camera::new` falla y la cámara ni se abre.
        // Pedir sólo 720p dejó sin cámara a quien no los ofreciera — y sin un
        // error en pantalla, «encender la cámara no hacía nada». `Closest`
        // tampoco vale: elige la resolución más cercana pero luego busca los
        // fps de la resolución **pedida**, así que también falla sin exacta.
        //
        // Las dos últimas aceptan lo que la cámara prefiera: pueden dar algo
        // pequeño o enorme, pero abren. El bucle de abajo ya publica con las
        // medidas que lleguen, así que abrir es lo único que importa.
        let attempts: [(&str, RequestedFormatType); 4] = [
            (
                "720p",
                RequestedFormatType::HighestResolution(Resolution::new(VIDEO_WIDTH, VIDEO_HEIGHT)),
            ),
            (
                "480p",
                RequestedFormatType::HighestResolution(Resolution::new(640, 480)),
            ),
            ("más fps", RequestedFormatType::AbsoluteHighestFrameRate),
            ("la mayor", RequestedFormatType::AbsoluteHighestResolution),
        ];
        // Igual que el micrófono: la elegida por nombre, y si ya no está, la
        // primera. El índice se resuelve ahora y no se guarda, porque enchufar
        // otra cámara los renumera.
        // Sólo entre las que pueden capturar, y por eso no vale `query` a secas:
        // el nodo de metadatos de la webcam se llama igual y sale antes.
        let usable = usable_cameras();
        let chosen_cam = CHOSEN_CAMERA.lock().unwrap().clone();
        let index_of = chosen_cam
            .and_then(|display_name| usable.iter().find(|c| c.human_name() == display_name))
            .or_else(|| usable.first())
            .map(|c| c.index().clone())
            .unwrap_or(CameraIndex::Index(0));
        note(format!(
            "cámara: {} útiles, se usa {index_of:?}",
            usable.len()
        ));
        let mut cam_on = None;
        let mut reasons = Vec::new();
        for (display_name, kind_of) in attempts {
            match Camera::new(index_of.clone(), RequestedFormat::new::<RgbFormat>(kind_of)) {
                Ok(mut c) => match c.open_stream() {
                    Ok(()) => {
                        note(format!(
                            "cámara: abierta pidiendo «{display_name}» → {}",
                            c.camera_format()
                        ));
                        cam_on = Some(c);
                        break;
                    }
                    Err(e) => {
                        note(format!("cámara: «{display_name}» abrió pero no arrancó: {e}"));
                        reasons.push(format!("{display_name}: {e}"));
                    }
                },
                Err(e) => {
                    note(format!("cámara: «{display_name}» no está disponible: {e}"));
                    reasons.push(format!("{display_name}: {e}"));
                }
            }
        }
        let Some(mut cam_on) = cam_on else {
            let _ = ready_tx.send(Err(format!(
                "la cámara no aceptó ningún formato ({})",
                reasons.join("; ")
            )));
            return;
        };

        // La fuente nace con la primera trama, y con **sus** medidas. Hasta
        // entonces no se sabe qué va a dar la cámara: lo que se le pide es una
        // preferencia, no una promesa.
        let mut source_handle: Option<NativeVideoSource> = None;
        let mut dims = (0u32, 0u32);
        // Un tropiezo no mata la captura, pero una racha sí — y **con motivo**.
        //
        // Antes era `let Ok(t) = cam_on.frame() else { break }`: el primer error
        // rompía el bucle, el hilo terminaba sin avisar a nadie y el llamante
        // sólo veía agotarse su plazo de veinte segundos. «La cámara no entregó
        // ninguna imagen» era todo lo que quedaba de un error que el driver sí
        // había explicado.
        const STREAK_MAX: u32 = 30;
        let mut in_a_row = 0u32;
        let mut last_error = String::new();

        // Un vigía para la primera trama.
        //
        // El diario de la v1.6.45 enseñaba la cámara abierta y **después nada**:
        // ni trama, ni fallo, ni rendición. Eso sólo pasa si una de las dos
        // llamadas de abajo no vuelve nunca, y desde fuera las dos se ven
        // igual. Estas marcas dicen cuál — y el vigía lo cuenta sin esperar a
        // que caduque el plazo de veinte segundos.
        //
        // Reproducido no está: la misma secuencia en un binario suelto da
        // 10/10 tramas tres veces seguidas (`spikes/camera-probe`). La
        // diferencia está en el entorno de la app, y esto es lo que la va a
        // señalar.
        let stage = std::sync::Arc::new(Mutex::new("abriendo"));
        {
            let stage = stage.clone();
            std::thread::spawn(move || {
                for wait in [3u64, 10] {
                    std::thread::sleep(std::time::Duration::from_secs(wait));
                    let d = *stage.lock().unwrap();
                    if d == "listo" {
                        return;
                    }
                    note(format!("cámara: {wait}s esperando y sigue en «{d}»"));
                }
            });
        }

        while CAMERA_ON.load(std::sync::atomic::Ordering::Relaxed) {
            if source_handle.is_none() {
                *stage.lock().unwrap() = "pidiendo la trama";
            }
            let rtc_frame = match cam_on.frame() {
                Ok(t) => {
                    in_a_row = 0;
                    t
                }
                Err(e) => {
                    in_a_row += 1;
                    last_error = format!("la cámara dejó de dar imagen: {e}");
                    if in_a_row == 1 || in_a_row == STREAK_MAX {
                        note(format!("cámara: fallo {in_a_row}/{STREAK_MAX} — {e}"));
                    }
                    if in_a_row >= STREAK_MAX {
                        break;
                    }
                    continue;
                }
            };
            if source_handle.is_none() {
                *stage.lock().unwrap() = "descodificando";
                note(format!(
                    "cámara: primera trama cruda, {} bytes en {}",
                    rtc_frame.buffer().len(),
                    rtc_frame.source_frame_format()
                ));
            }
            let rgb = match rtc_frame.decode_image::<RgbFormat>() {
                Ok(r) => r,
                Err(e) => {
                    in_a_row += 1;
                    last_error = format!("no se pudo descodificar lo que da la cámara: {e}");
                    if in_a_row == 1 || in_a_row == STREAK_MAX {
                        note(format!(
                            "cámara: no descodifica {in_a_row}/{STREAK_MAX} — {e}"
                        ));
                    }
                    if in_a_row >= STREAK_MAX {
                        break;
                    }
                    continue;
                }
            };
            let (w, h) = (rgb.width(), rgb.height());
            if w == 0 || h == 0 {
                continue;
            }
            // Si la cámara cambia de resolución a media captura —pasa al
            // reenfocar en algunas— se rehace la fuente en vez de tirar tramas.
            if source_handle.is_none() || dims != (w, h) {
                let f = NativeVideoSource::new(
                    VideoResolution {
                        width: w,
                        height: h,
                    },
                    // `false` — una cara. El SFU lo usa para decidir su
                    // estrategia: en una cámara prioriza la fluidez, en una
                    // pantalla el detalle del texto aunque baje la tasa.
                    false,
                );
                if source_handle.is_none() {
                    *stage.lock().unwrap() = "listo";
                    note(format!("cámara: primera trama {w}x{h}"));
                    let _ = source_tx.send(f.clone());
                    let _ = ready_tx.send(Ok((w, h)));
                } else {
                    note(format!("cámara: cambió a {w}x{h}, se rehace la pista"));
                }
                source_handle = Some(f);
                dims = (w, h);
            }
            // Un buffer por trama: `I420Buffer` no se puede clonar y el frame
            // se lo lleva. Reusarlo exigiría que la conversión y el envío no se
            // solapen, que es sincronización a cambio de una asignación que el
            // asignador resuelve en nada.
            let mut buffer = I420Buffer::new(w, h);
            rgb_a_i420(rgb.as_raw(), w, h, &mut buffer);
            keep_me(crate::video_frames::Fuente::Camara, &buffer, w, h);
            source_handle
                .as_ref()
                .expect("recién creada")
                .capture_frame(&VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_micros() as i64)
                        .unwrap_or(0),
                    buffer,
                    frame_metadata: Default::default(),
                });
        }
        let _ = cam_on.stop_stream();

        // Si el bucle se acabó **antes** de la primera trama, alguien está
        // esperando una respuesta que ya no va a llegar por otro camino. Decir
        // el motivo aquí es la diferencia entre un diagnóstico y un plazo
        // agotado; si ya había tramas, el canal está cerrado y esto no hace
        // nada, que es lo correcto.
        if source_handle.is_none() {
            let because = if last_error.is_empty() {
                "la captura se detuvo antes de la primera imagen".to_string()
            } else {
                last_error
            };
            note(format!("cámara: se rinde — {because}"));
            let _ = ready_tx.send(Err(because));
            return;
        }

        // Se rindió **después** de haber dado imagen, y eso antes no lo contaba
        // nadie: el canal de arranque ya estaba cerrado, así que el hilo
        // terminaba en silencio con la bandera en alto. Quedaba el botón
        // encendido, la pista publicando una fuente muerta, y ni un aviso —el
        // caso de una cámara que otra aplicación te quita a media llamada.
        //
        // No hay por dónde mandar el motivo, así que va al diario y la interfaz
        // recibe lo único que puede pintar: que la cámara está apagada. Es
        // menos de lo que uno querría y muchísimo más que mentir.
        CAMERA_ON.store(false, std::sync::atomic::Ordering::Relaxed);
        let because = if last_error.is_empty() {
            "la cámara dejó de entregar imagen".to_string()
        } else {
            last_error
        };
        note(format!("cámara: se apaga a media llamada — {because}"));
        if let Some(me) = ME.lock().unwrap().clone() {
            emit(VoiceEvent::Video {
                identity: me,
                source: crate::video_frames::Fuente::Camara.como_texto().into(),
                enabled: false,
            });
        }
    });

    // Con plazo: entre abrir el dispositivo y la primera trama hay un momento,
    // y en macOS puede aparecer de por medio el diálogo del permiso.
    match ready_rx.recv_timeout(std::time::Duration::from_secs(20)) {
        Ok(Ok((w, h))) => {
            let source_handle = source_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .map_err(|_| "la cámara arrancó sin fuente".to_string())?;
            Ok((source_handle, w, h))
        }
        Ok(Err(e)) => Err(e),
        // Desconectado y agotado no son lo mismo y no se pueden contar igual:
        // el primero es que el hilo de captura ha muerto —un pánico, sin ir más
        // lejos— y el segundo que sigue vivo sin dar imagen. Decir «no entregó
        // ninguna imagen» ante un hilo muerto costó cinco versiones.
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            note("cámara: el hilo de captura murió sin decir nada");
            Err("voice-camera-thread-died".into())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("voice-camera-no-frames".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_usable, has_voice, clean_devices, rtt_nominado, DeviceEntry, VOICE_THRESHOLD};

    fn d(id: &str, name: &str) -> DeviceEntry {
        DeviceEntry {
            id: id.into(),
            name: name.into(),
            current: false,
        }
    }

    /// Lo que de verdad enumera ALSA en un portátil con PipeWire. Sacado de
    /// `arecord -L` y del desplegable que salió en la v1.6.40: quince entradas
    /// para un micrófono.
    fn what_is_really_there() -> Vec<DeviceEntry> {
        vec![
            d("alsa:null", "Discard all samples"),
            d("alsa:lavrate", "Rate Converter Plugin Using Libav/FFmpeg"),
            d("alsa:samplerate", "Rate Converter Plugin Using Samplerate"),
            d("alsa:speexrate", "Rate Converter Plugin Using Speex"),
            d("alsa:jack", "JACK Audio Connection Kit"),
            d("alsa:oss", "Open Sound System"),
            d("alsa:pipewire", "PipeWire Sound Server"),
            d("alsa:pulse", "PulseAudio Sound Server"),
            d("alsa:speex", "Plugin using Speex DSP"),
            d("alsa:upmix", "Plugin for channel upmix (4,6,8)"),
            d("alsa:vdownmix", "Plugin for channel downmix (stereo)"),
            d(
                "alsa:default",
                "Default ALSA Output (currently PipeWire Media Server)",
            ),
            d("alsa:usbstream:CARD=NVidia", "HDA NVidia"),
            d("alsa:sysdefault:CARD=sofhdadsp", "sof-hda-dsp,"),
            d("alsa:usbstream:CARD=sofhdadsp", "sof-hda-dsp,"),
        ]
    }

    // De quince entradas, dos sirven para elegir un micrófono. Las otras trece
    // son plugins de ALSA con nombres que suenan a dispositivo.
    #[test]
    fn the_picker_only_shows_microphones() {
        let clean = clean_devices(what_is_really_there());
        let names: Vec<&str> = clean.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Default ALSA Output (currently PipeWire Media Server)",
                "sof-hda-dsp,"
            ],
            "quedaron {} entradas",
            clean.len()
        );
    }

    // El mismo códec sale como varios subdispositivos con la misma
    // descripción. Ocho «sof-hda-dsp,» seguidos no son ocho micrófonos.
    #[test]
    fn the_same_name_does_not_show_twice() {
        let clean = clean_devices(vec![
            d("alsa:hw:1,0", "sof-hda-dsp,"),
            d("alsa:hw:1,6", "sof-hda-dsp,"),
            d("alsa:hw:1,7", "sof-hda-dsp,"),
        ]);
        assert_eq!(clean.len(), 1);
    }

    // Un permitido puede dejar fuera algo válido que no vimos venir. Que la
    // lista se quede vacía es peor que enseñarla sucia: sin entradas, quien
    // tiene el micrófono equivocado no tiene ni cómo intentarlo.
    #[test]
    fn never_filters_down_to_nothing() {
        let odd = vec![d("alsa:algo-que-no-conocemos", "Un micro de otro planeta")];
        assert_eq!(clean_devices(odd).len(), 1);
    }

    // Windows y macOS enumeran limpio; el filtro es un apaño para ALSA y no
    // tiene por qué opinar sobre los demás.
    #[test]
    fn outside_alsa_nothing_is_touched() {
        assert!(is_usable("coreaudio:BuiltInMicrophoneDevice"));
        assert!(is_usable("wasapi:{0.0.1.00000000}.{abc}"));
    }

    /// Todo comando que toque el SDK tiene que ser `async`.
    ///
    /// Esto lee su propio fichero, y es la única forma que encontré de vigilar
    /// el fallo que cerró la app al silenciarse. Tauri corre los comandos
    /// síncronos en el hilo principal, fuera de todo runtime de Tokio; el SDK
    /// avisa al servidor con `tokio::task::spawn`, que entra en pánico si no
    /// hay runtime, y un pánico ahí se lleva el proceso. No hay prueba de
    /// unidad que llegue: hace falta una llamada abierta y alguien pulsando.
    ///
    /// Las excepciones se nombran una a una. Que haya que escribir el nombre
    /// aquí es el punto: convierte «se me olvidó» en «decidí que éste puede».
    #[test]
    fn sdk_commands_are_async() {
        const MAY_BE_SYNC: &[&str] = &[
            // Escribe un booleano atómico y nada más.
            "voice_set_deaf",
        ];

        let source_handle = include_str!("voice.rs");
        let mut sync_ok = Vec::new();
        let mut marked = false;
        for line in source_handle.lines() {
            let l = line.trim();
            if l == "#[tauri::command]" {
                marked = true;
                continue;
            }
            if !marked || l.is_empty() || l.starts_with("///") || l.starts_with("//") {
                continue;
            }
            marked = false;
            if let Some(rest) = l.strip_prefix("pub fn ") {
                let display_name = rest.split('(').next().unwrap_or(rest);
                if !MAY_BE_SYNC.contains(&display_name) {
                    sync_ok.push(display_name.to_string());
                }
            }
        }
        assert!(
            sync_ok.is_empty(),
            "estos comandos son síncronos y no están en la lista de excepciones: {sync_ok:?}.\n\
             Un comando síncrono corre en el hilo principal; si toca el SDK de LiveKit, \
             cierra la app. Hazlo `async` o justifícalo en PUEDEN_SER_SINCRONOS."
        );
    }

    /// Quien crea una `NativeVideoSource` tiene que estar dentro del runtime.
    ///
    /// El hermano de la prueba de arriba, y el mismo fallo un piso más abajo:
    /// allí era un comando síncrono en el hilo principal, aquí un
    /// `std::thread::spawn` nuestro. En los dos casos el SDK hace
    /// `tokio::spawn` por dentro y se muere sin runtime.
    ///
    /// Mira funciones enteras y no cada `spawn` por separado a propósito:
    /// contar llaves en este fichero no es de fiar —los `format!` llevan las
    /// suyas dentro de las cadenas— y una función que crea la fuente y no
    /// menciona el runtime en ninguna parte ya es sospechosa de sobra.
    #[test]
    fn who_creates_the_video_source_enters_the_runtime() {
        let source_handle = include_str!("voice.rs");
        let mut culprits = Vec::new();
        let mut inside: Option<(&str, String)> = None;
        for line in source_handle.lines() {
            // La llave sola en la primera columna cierra la función. Es lo que
            // hace rustfmt sin excepción, y sirve donde contar llaves no
            // serviría. Sin este cierre el cuerpo de la última función seguía
            // hasta el final del fichero y se tragaba este mismo módulo de
            // pruebas — que menciona `.inner().enter()` ahí abajo. La regla se
            // cumplía sola y el mutante sobrevivió.
            if line == "}" {
                if let Some((display_name, body)) = inside.take() {
                    if body.contains("NativeVideoSource::new(")
                        && !body.contains("enter_runtime(")
                    {
                        culprits.push(display_name.to_string());
                    }
                }
                continue;
            }
            if let Some(rest) = line
                .strip_prefix("fn ")
                .or_else(|| line.strip_prefix("pub fn "))
            {
                inside = Some((rest.split('(').next().unwrap_or(rest), String::new()));
            }
            if let Some((_, body)) = inside.as_mut() {
                body.push_str(line);
                body.push('\n');
            }
        }

        assert!(
            culprits.is_empty(),
            "{culprits:?} crean una NativeVideoSource sin entrar al runtime de Tokio.\n\
             `NativeVideoSource::new` hace `tokio::spawn` por dentro: fuera de un \
             runtime el hilo muere en el sitio y la captura se queda sin primera \
             trama. Añade `let _in_runtime = enter_runtime(&handle_ref);` al \
             principio del hilo."
        );
    }

    /// Y que sea verdad, no sólo que lo diga el comentario.
    ///
    /// Esto vigila al SDK, no a nosotros: si algún día `NativeVideoSource::new`
    /// deja de hacer `tokio::spawn` por dentro, esta prueba cae y la de arriba
    /// —con su regla y su explicación— sobra. Mejor enterarse así que
    /// arrastrar una precaución que ya no protege de nada.
    #[test]
    fn without_runtime_the_video_source_kills_the_thread() {
        use livekit::webrtc::video_source::{native::NativeVideoSource, VideoResolution};

        let dims = || VideoResolution {
            width: 320,
            height: 240,
        };

        // El pánico es el resultado esperado: sin esto la salida de `cargo
        // test` se llena de un rastro que parece un fallo y no lo es.
        let before = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let loose = std::thread::spawn(move || NativeVideoSource::new(dims(), false)).join();
        std::panic::set_hook(before);
        assert!(
            loose.is_err(),
            "el SDK ya no necesita runtime: `NativeVideoSource::new` dejó de hacer \
             `tokio::spawn` por dentro, así que `enter_runtime` y su prueba sobran"
        );

        let rt = tokio::runtime::Runtime::new().expect("runtime de prueba");
        let handle_ref = rt.handle().clone();
        let inside = std::thread::spawn(move || {
            let _in_runtime = handle_ref.enter();
            NativeVideoSource::new(dims(), false)
        })
        .join();
        assert!(
            inside.is_ok(),
            "entrar al runtime desde el hilo tendría que bastar"
        );
    }

    fn tone(amplitude: f32) -> Vec<i16> {
        (0..480)
            .map(|i| {
                let t = i as f32 / 48_000.0;
                ((t * 440.0 * std::f32::consts::TAU).sin() * amplitude * i16::MAX as f32) as i16
            })
            .collect()
    }

    // Silencio absoluto es lo que produce `MUTED` poniendo las muestras a
    // cero, así que silenciarse tiene que apagar el indicador sin ningún caso
    // especial en ningún sitio.
    #[test]
    fn silence_is_not_speech() {
        assert!(!has_voice(&vec![0i16; 480]));
        assert!(!has_voice(&[]));
    }

    // El ruido de fondo de una habitación queda muy por debajo del umbral. Si
    // esto empezara a dar `true`, el punto verde estaría encendido siempre y
    // dejaría de significar nada.
    #[test]
    fn background_noise_is_not_speech() {
        assert!(!has_voice(&tone(VOICE_THRESHOLD / 4.0)));
    }

    #[test]
    fn a_normal_voice_is_speech() {
        assert!(has_voice(&tone(0.2)));
    }

    // Lo que RMS compra frente al pico: un roce satura una muestra y deja el
    // resto en silencio. Con el pico eso sería «hablando»; con la energía, no.
    #[test]
    fn a_soft_brush_is_not_speech() {
        let mut brush = vec![0i16; 480];
        brush[100] = i16::MAX / 8;
        brush[101] = i16::MIN / 8;
        assert!(!has_voice(&brush));
    }

    // Y lo que **no** compra, escrito para que nadie lo descubra creyendo que
    // es un fallo: un golpe fuerte en diez milisegundos lleva tanta energía
    // como voz. Un teclazo cerca del micro enciende el punto un instante.
    // Distinguirlo pide un detector de voz de verdad, que mira varias tramas.
    #[test]
    fn a_loud_knock_does_and_is_accepted() {
        let mut knock = vec![0i16; 480];
        knock[100] = i16::MAX;
        knock[101] = i16::MIN;
        assert!(has_voice(&knock));
    }
    use livekit::webrtc::stats::{dictionaries, CandidatePairStats, RtcStats};

    fn pair(nominated_pair: bool, rtt: f64) -> RtcStats {
        RtcStats::CandidatePair(CandidatePairStats {
            rtc: dictionaries::RtcStats::default(),
            candidate_pair: dictionaries::CandidatePairStats {
                nominated: nominated_pair,
                current_round_trip_time: rtt,
                ..Default::default()
            },
        })
    }

    // ICE prueba varios caminos y deja un `CandidatePair` por cada uno. Casi
    // todos son callejones sin salida con el contador a cero; el que vale es el
    // nominado. Coger el primero de la lista es el fallo fácil, y da un número
    // que parece medido sin corresponder a nada.
    #[test]
    fn takes_the_nominated_pair_not_the_first() {
        let stats = vec![pair(false, 0.500), pair(true, 0.038), pair(false, 0.900)];
        assert_eq!(rtt_nominado(&stats), Some(0.038));
    }

    // Un par nominado recién elegido puede no haber completado todavía un
    // consent check. Su cero no es «cero milisegundos», es «no lo sé», y
    // enseñarlo en la cabecera se lee como una conexión perfecta justo cuando
    // aún se está estableciendo.
    #[test]
    fn a_zero_is_not_a_measurement() {
        assert_eq!(rtt_nominado(&[pair(true, 0.0)]), None);
    }

    #[test]
    fn without_a_nominated_pair_it_invents_nothing() {
        assert_eq!(rtt_nominado(&[pair(false, 0.120)]), None);
    }
}

#[cfg(test)]
mod resampling_tests {
    use super::*;

    /// Bloques del tamaño que entrega una tarjeta de verdad.
    ///
    /// **No** de 10 ms redondos, y ahí estuvo el primer intento fallido de esta
    /// prueba: 44100/48000 es 0,91875 exacto, así que un bloque de 441 cuadros
    /// da exactamente 480 muestras y el arrastre vale cero **siempre**. Con ese
    /// tamaño pasaba con y sin arrastre, o sea que no probaba nada.
    ///
    /// cpal entrega lo que el dispositivo le dé —512 es de lo más común en
    /// WASAPI—, y ahí es donde el arrastre importa.
    const PER_BLOCK: usize = 512;

    fn blocks(rate: u32, how_many: usize) -> Vec<Vec<f32>> {
        (0..how_many)
            .map(|b| {
                (0..PER_BLOCK)
                    .map(|i| {
                        // Una senoide de 440 Hz continua entre bloques: los
                        // fallos de fase se ven en una onda y en una rampa
                        // monótona pasan desapercibidos.
                        let n = (b * PER_BLOCK + i) as f32;
                        (n * 2.0 * std::f32::consts::PI * 440.0 / rate as f32).sin() * 0.5
                    })
                    .collect()
            })
            .collect()
    }

    fn run_ticks(rate: u32, how_many: usize) -> Vec<i16> {
        let step = rate as f32 / SAMPLE_RATE as f32;
        let mut output = Vec::new();
        let mut phase = Phase::default();
        for b in blocks(rate, how_many) {
            resample(&b, step, &mut phase, false, &mut output);
        }
        output
    }

    /// El salto más grande entre dos muestras seguidas. En una senoide limpia es
    /// su pendiente máxima; un codo de resampleo lo dispara por encima.
    fn jump(v: &[i16]) -> i32 {
        v.windows(2)
            .map(|p| (p[1] as i32 - p[0] as i32).abs())
            .max()
            .unwrap()
    }

    /// Al mismo ritmo la cuenta no cambia (salvo la muestra que se aplaza).
    #[test]
    fn at_48k_nothing_changes() {
        let n = run_ticks(48_000, 10).len();
        assert!(
            (PER_BLOCK * 10 - 1..=PER_BLOCK * 10).contains(&n),
            "dio {n}"
        );
    }

    /// El caso que rompía: 44 100 tiene que salir como 48 000. Si sale más
    /// corto o más largo, la voz va acelerada o lenta.
    #[test]
    fn from_44k_comes_48k() {
        let n = run_ticks(44_100, 100).len();
        let expected = (PER_BLOCK * 100) as f32 * 48_000.0 / 44_100.0;
        assert!(
            (n as f32 - expected).abs() <= 2.0,
            "de 44100 salieron {n} muestras y se esperaban unas {expected:.0}"
        );
    }

    /// La pendiente máxima de la propia onda, que es el suelo de todo esto.
    ///
    /// A 440 Hz, media escala y 48 kHz de salida: `2π·440/48000 · 0,5 · 32767`.
    /// Un remuestreo transparente se queda **en** ese número; cualquier codo lo
    /// pasa. Es lo que convierte «el audio suena raro» en algo medible.
    const WAVE_SLOPE: i32 = 943;

    /// El remuestreo no añade nada audible: el salto más grande que sale es el
    /// de la onda, no uno suyo.
    #[test]
    fn the_output_is_the_wave_not_an_elbow() {
        let maximum = jump(&run_ticks(44_100, 20));
        assert!(
            maximum <= WAVE_SLOPE + 10,
            "el salto máximo fue {maximum} y la onda sola da {WAVE_SLOPE}"
        );
    }

    /// **La que importa.** Sin arrastre de fase, cada bloque reempieza en la
    /// muestra 0 y aparece una discontinuidad cada 512 cuadros: un clic
    /// constante que suena a «micrófono malo» y no a bug.
    ///
    /// Se compara contra la pendiente de la onda y no «el doble del bueno»: el
    /// bueno ya está en el suelo físico, así que pedirle al roto que lo doble es
    /// pedir un codo enorme. Lo que hay que afirmar es que el roto **se sale** de
    /// lo que la onda puede dar, y el bueno no.
    #[test]
    fn without_carrying_the_phase_elbows_appear() {
        let step = 44_100f32 / SAMPLE_RATE as f32;
        let mut sin = Vec::new();
        for b in blocks(44_100, 20) {
            // Fase nueva en cada bloque: el bug.
            resample(&b, step, &mut Phase::default(), false, &mut sin);
        }

        assert!(
            jump(&sin) > WAVE_SLOPE + 100,
            "sin arrastrar la fase el salto fue {}, y debería salirse de {WAVE_SLOPE}",
            jump(&sin)
        );
        assert!(jump(&run_ticks(44_100, 20)) <= WAVE_SLOPE + 10);
    }

    /// Silenciado son ceros, pero **la fase sigue corriendo**: si se parara, al
    /// quitar el silencio la voz saldría desfasada con un chasquido.
    #[test]
    fn muted_gives_zeros_keeping_the_phase() {
        let step = 44_100f32 / SAMPLE_RATE as f32;
        let (mut silent, mut normal) = (Vec::new(), Vec::new());
        let (mut fm, mut fnorm) = (Phase::default(), Phase::default());
        for b in blocks(44_100, 5) {
            resample(&b, step, &mut fm, true, &mut silent);
            resample(&b, step, &mut fnorm, false, &mut normal);
        }
        assert!(silent.iter().all(|&m| m == 0));
        assert_eq!(silent.len(), normal.len());
        assert_eq!(fm.pos, fnorm.pos);
    }

    /// Un bloque vacío no puede colgar el bucle ni mover la fase.
    #[test]
    fn an_empty_block_does_nothing() {
        let mut output = Vec::new();
        let mut phase = Phase::default();
        resample(&[], 0.91875, &mut phase, false, &mut output);
        assert!(output.is_empty());
        assert_eq!(phase.pos, 0.0);
    }
}

#[cfg(test)]
mod recording_tests {
    use super::{recording_from_metadata, RecordingSignal};

    /// El metadata de una sala lo escribe **otro proceso**, y llega de todas
    /// las formas: vacío cuando la sala es nueva, `{}` cuando se acaba de
    /// parar, roto si alguien lo tocó a mano. Ninguna de las tres es un error
    /// que deba encender un chip, y ninguna puede reventar el motor de voz.
    #[test]
    fn sin_grabacion_no_hay_señal() {
        for raw_peak in ["", "{}", "no soy json", "null", "[]", r#"{"otra":"cosa"}"#] {
            assert_eq!(recording_from_metadata(raw_peak), None, "con {raw_peak:?}");
        }
    }

    /// El caso que más se da: se acaba de parar. El backend deja la clave a
    /// `null` en vez de borrarla, y eso significa «ya no».
    #[test]
    fn a_null_recording_is_not_recording() {
        assert_eq!(recording_from_metadata(r#"{"recording":null}"#), None);
    }

    /// Un objeto a medias **tampoco** enciende el chip.
    ///
    /// Es la decisión deliberada: preferimos no avisar a avisar de una
    /// grabación sin dueño. Un punto rojo que no sabe decir quién está grabando
    /// es peor que ninguno.
    #[test]
    fn half_way_does_not_count() {
        for raw_peak in [
            r#"{"recording":{}}"#,
            r#"{"recording":{"id":"rec-1"}}"#,
            r#"{"recording":{"by":"u-ana"}}"#,
            r#"{"recording":{"id":"","by":"u-ana"}}"#,
            r#"{"recording":{"id":"rec-1","by":""}}"#,
            r#"{"recording":{"id":1,"by":"u-ana"}}"#,
        ] {
            assert_eq!(recording_from_metadata(raw_peak), None, "con {raw_peak}");
        }
    }

    #[test]
    fn con_id_y_dueño_sí() {
        let r = recording_from_metadata(
            r#"{"recording":{"id":"rec-1","by":"u-ana","since":"2026-09-18T00:00:00Z"}}"#,
        );
        assert_eq!(
            r,
            Some(RecordingSignal {
                id: "rec-1".into(),
                by: "u-ana".into(),
                since: "2026-09-18T00:00:00Z".into(),
            })
        );
    }

    /// `since` es para enseñar «lleva 3 min»; sin ella el chip sigue
    /// valiendo. Que falte no puede apagar el aviso.
    #[test]
    fn without_since_the_chip_stays_on() {
        let r = recording_from_metadata(r#"{"recording":{"id":"rec-1","by":"u-ana"}}"#).unwrap();
        assert_eq!(r.since, "");
        assert_eq!(r.id, "rec-1");
    }

    /// Y el metadata puede traer más cosas: el backend es el único que escribe
    /// hoy, pero una versión futura podría añadir otra clave al lado.
    #[test]
    fn lives_with_other_keys() {
        let r = recording_from_metadata(
            r#"{"algo":"otro","recording":{"id":"rec-1","by":"u-ana"},"mas":1}"#,
        );
        assert!(r.is_some());
    }
}

/// Engancharse a una llamada en curso después de recargar la página.
#[cfg(test)]
mod attach_tests {
    use super::{snapshot, RemotePeer};
    use crate::video_frames::Fuente;

    fn json(evs: Vec<super::VoiceEvent>) -> Vec<serde_json::Value> {
        evs.into_iter().map(|e| serde_json::to_value(e).unwrap()).collect()
    }

    fn remote(id: &str, silent: Option<bool>, videos: Vec<Fuente>, speaking_flag: bool) -> RemotePeer {
        RemotePeer {
            identity: id.into(),
            name: format!("nombre de {id}"),
            speaking_flag,
            silent,
            videos,
        }
    }

    /// La pantalla nueva tiene que ver a todos, con su micro como está.
    /// Quien no ha publicado micro no dice nada sobre él: la pantalla no debe
    /// afirmar que está abierto ni cerrado.
    #[test]
    fn the_snapshot_has_everyone_and_their_mics() {
        let evs = json(snapshot(
            "yo",
            &[
                remote("ana", Some(true), vec![], false),
                remote("beto", None, vec![], false),
            ],
            "",
        ));
        assert_eq!(evs[0], serde_json::json!({"kind":"connected","identity":"yo"}));
        assert!(evs.contains(&serde_json::json!({"kind":"joined","identity":"ana","name":"nombre de ana"})));
        assert!(evs.contains(&serde_json::json!({"kind":"joined","identity":"beto","name":"nombre de beto"})));
        assert!(evs.contains(&serde_json::json!({"kind":"muted","identity":"ana","muted":true})));
        assert!(
            !evs.iter().any(|e| e["kind"] == "muted" && e["identity"] == "beto"),
            "de beto no se sabe nada del micro y se dijo algo: {evs:?}"
        );
        // Y el «está» de cada uno va antes que su micro, como al entrar.
        let pos = |k: &str, id: &str| evs.iter().position(|e| e["kind"] == k && e["identity"] == id);
        assert!(pos("joined", "ana") < pos("muted", "ana"));
    }

    /// Sólo el vídeo al que estamos suscritos: de otro no llega trama, y
    /// anunciarlo pinta un lienzo negro. `RemotePeer.videos` ya viene filtrado —lo
    /// filtra `voice_attach`—, así que aquí se fija que se anuncia cada uno con
    /// su fuente y ninguno más.
    #[test]
    fn only_arriving_video_is_announced() {
        let evs = json(snapshot(
            "yo",
            &[
                remote("ana", Some(false), vec![Fuente::Pantalla], false),
                remote("beto", Some(false), vec![], false),
            ],
            "",
        ));
        let videos: Vec<_> = evs.iter().filter(|e| e["kind"] == "video").collect();
        assert_eq!(
            videos,
            vec![&serde_json::json!({"kind":"video","identity":"ana","source":"screen","enabled":true})]
        );
    }

    /// Quién habla es la lista entera, como la del servidor.
    #[test]
    fn the_snapshot_says_who_speaks() {
        let evs = json(snapshot(
            "yo",
            &[remote("ana", None, vec![], true), remote("beto", None, vec![], false)],
            "",
        ));
        assert!(evs.contains(&serde_json::json!({"kind":"speaking","identities":["ana"]})));
    }

    /// Y si se está grabando. Es lo que menos puede perderse al recargar: el
    /// chip REC es la única forma de saberlo.
    #[test]
    fn the_snapshot_says_if_recording() {
        let evs = json(snapshot("yo", &[], r#"{"recording":{"id":"rec-1","by":"u-ana"}}"#));
        let rec = evs.iter().find(|e| e["kind"] == "recording").expect("sin evento de grabación");
        assert_eq!(rec["active"], true);
        assert_eq!(rec["id"], "rec-1");

        let evs = json(snapshot("yo", &[], ""));
        let rec = evs.iter().find(|e| e["kind"] == "recording").unwrap();
        assert_eq!(rec["active"], false, "sin grabación, el chip se apaga");
    }

    /// Ningún bucle guarda su propio canal de eventos.
    ///
    /// Esto lee su propio fichero, como `sdk_commands_are_async`.
    /// Un bucle con su copia del `Channel` le sigue hablando a la página de
    /// antes de recargar, y la nueva se queda sorda. Peor: el de la captura se
    /// rendía al primer envío fallido y **dejaba de publicar tu voz**. Todo
    /// envío va por `emit`, que lee `CHANNEL` cada vez. Los únicos que tocan un
    /// canal a mano son quienes lo reciben de la pantalla.
    #[test]
    fn no_loop_keeps_its_own_channel() {
        const CHANNEL_USERS: &[&str] = &["emit", "voice_join", "voice_attach"];

        let source_handle = include_str!("voice.rs");
        let stop = source_handle.find("#[cfg(test)]").unwrap_or(source_handle.len());
        let mut func = String::new();
        let mut bad = Vec::new();
        for line in source_handle[..stop].lines() {
            let l = line.trim_start();
            // Sólo las de primer nivel: un `fn drop` anidado no es otra función.
            for pre in ["pub async fn ", "async fn ", "pub fn ", "fn "] {
                if let Some(rest) = line.strip_prefix(pre) {
                    func = rest.split(['(', '<']).next().unwrap_or("").to_string();
                    break;
                }
            }
            if l.starts_with("//") {
                continue;
            }
            let touches = l.contains("Channel<VoiceEvent>") || l.contains(".send(VoiceEvent") || l.contains("chan.send(") || l.contains("on_event.send(");
            // `static CHANNEL` es la declaración del único canal.
            if touches && !l.starts_with("static CHANNEL") && !CHANNEL_USERS.contains(&func.as_str()) {
                bad.push(format!("{func}: {}", l.trim()));
            }
        }
        assert!(
            bad.is_empty(),
            "estas funciones mandan por un canal propio en vez de por `emit`: {bad:#?}"
        );
    }
}

#[cfg(test)]
mod screen_tests {
    use super::bgra_to_i420;
    use livekit::webrtc::video_frame::I420Buffer;

    /// Una trama BGRA de 4×4 con colores distintos por píxel, y relleno al
    /// final de cada fila como el de macOS. El relleno es blanco puro: si se
    /// leyera como imagen, se vería.
    fn rtc_frame(stride: usize) -> Vec<u8> {
        let (w, h) = (4usize, 4usize);
        let mut v = vec![0xFFu8; stride * h];
        for line_out in 0..h {
            for col in 0..w {
                let i = line_out * stride + col * 4;
                v[i] = (10 + col * 40) as u8; // B
                v[i + 1] = (20 + line_out * 50) as u8; // G
                v[i + 2] = (30 + col * 20 + line_out * 50) as u8; // R
                v[i + 3] = 0xFF;
            }
        }
        v
    }

    /// Los tres planos, sin el relleno que puedan llevar ellos mismos.
    fn planes(buf: &I420Buffer) -> Vec<u8> {
        let (sy, su, sv) = buf.strides();
        let (y, u, v) = buf.data();
        let mut out: Vec<u8> = (0..4).flat_map(|f| (0..4).map(move |c| y[f * sy as usize + c])).collect();
        for f in 0..2 {
            for c in 0..2 {
                out.push(u[f * su as usize + c]);
                out.push(v[f * sv as usize + c]);
            }
        }
        out
    }

    /// Con relleno en cada fila sale lo mismo que sin él (#98). Ignorando el
    /// stride, la segunda fila empezaría en el relleno de la primera.
    #[test]
    fn rows_with_padding_read_like_packed_rows() {
        let mut packaged = I420Buffer::new(4, 4);
        assert!(bgra_to_i420(&rtc_frame(16), 4, 4, 16, &mut packaged));
        let mut with_padding = I420Buffer::new(4, 4);
        assert!(bgra_to_i420(&rtc_frame(64), 4, 4, 64, &mut with_padding));
        assert_eq!(planes(&packaged), planes(&with_padding));
    }

    /// Una trama que no cabe en lo que dice medir no se lee: se salta.
    #[test]
    fn a_frame_shorter_than_its_stride_is_skipped() {
        let mut b = I420Buffer::new(4, 4);
        assert!(!bgra_to_i420(&rtc_frame(64)[..64 * 3 + 15], 4, 4, 64, &mut b));
        assert!(!bgra_to_i420(&rtc_frame(16), 4, 4, 8, &mut b));
    }
}

#[cfg(test)]
mod source_tests {
    use super::{the_system_chooses, source_index};

    fn ids() -> Vec<String> {
        vec!["65".into(), "66".into()]
    }

    // Con dos monitores se comparte el elegido, no el primero (#117).
    #[test]
    fn the_chosen_screen_is_shared() {
        assert_eq!(source_index(&ids(), Some("66")), Some(1));
        assert_eq!(source_index(&ids(), Some("65")), Some(0));
    }

    // Sin elección, o con una que ya no está (se desenchufó el HDMI), la
    // primera, como siempre; y sin fuentes, ninguna.
    #[test]
    fn without_a_valid_choice_the_first_one() {
        assert_eq!(source_index(&ids(), None), Some(0));
        assert_eq!(source_index(&ids(), Some("99")), Some(0));
        assert_eq!(source_index(&[], Some("65")), None);
    }

    // En Wayland pregunta el portal; en X11 (bspwm), la app.
    #[test]
    fn wayland_chooses_x11_asks() {
        assert!(the_system_chooses(Some("wayland"), None));
        assert!(the_system_chooses(Some("tty"), Some("wayland-0")));
        assert!(!the_system_chooses(Some("x11"), None));
        assert!(!the_system_chooses(None, Some("")));
    }
}

#[cfg(test)]
mod processing_tests {
    use super::*;

    /// Ruido blanco reproducible (un LCG): sin dependencias ni azar entre
    /// corridas.
    fn noise(n: usize, amplitude: f32, seed_state: &mut u32) -> Vec<f32> {
        (0..n)
            .map(|_| {
                *seed_state = seed_state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((*seed_state >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * amplitude
            })
            .collect()
    }

    fn to_i16(x: &[f32]) -> Vec<i16> {
        x.iter().map(|v| (v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).collect()
    }

    fn rms(x: &[i16]) -> f32 {
        let s: f64 = x.iter().map(|&v| (v as f64) * (v as f64)).sum();
        ((s / x.len().max(1) as f64).sqrt()) as f32
    }

    fn db(a: f32, b: f32) -> f32 {
        20.0 * (a.max(1e-6) / b.max(1e-6)).log10()
    }

    /// Pasa una señal entera por el procesador, trama a trama, como la captura.
    fn process_all(p: &mut Processor, on: bool, signal: &[i16]) -> Vec<i16> {
        let mut out = Vec::with_capacity(signal.len());
        for t in signal.chunks(SAMPLES_PER_FRAME) {
            let mut t = t.to_vec();
            p.process_frame(on, &mut t, vec![]).unwrap();
            out.extend(t);
        }
        out
    }

    /// Ruido sostenido a 0,05 de la escala, el último segundo de tres (el
    /// supresor tarda unos cientos de milisegundos en aprenderlo). Medido al
    /// escribirlo: baja 14,3 dB.
    fn noise_in_and_out() -> (Vec<i16>, Vec<i16>) {
        let mut seed = 7;
        let n = SAMPLE_RATE as usize * 3;
        let input = to_i16(&noise(n, 0.05, &mut seed));
        let out_samples = process_all(&mut Processor::new(), true, &input);
        (input, out_samples)
    }

    #[test]
    fn background_noise_drops() {
        let (input, out_samples) = noise_in_and_out();
        let tail = input.len() - SAMPLE_RATE as usize;
        let drops_db = db(rms(&out_samples[tail..]), rms(&input[tail..]));
        assert!(drops_db <= -10.0, "el ruido sólo bajó {drops_db:.1} dB");
    }

    /// Y la voz no se va con él: ráfagas de 300 Hz de 200 ms —una sílaba
    /// cada 400 ms— sobre el mismo ruido salen con su nivel. Medido: +0,5 dB.
    #[test]
    fn the_voice_survives_noise_suppression() {
        let mut seed = 7;
        let n = SAMPLE_RATE as usize * 3;
        let span = SAMPLE_RATE as usize / 5;
        let base = noise(n, 0.05, &mut seed);
        let mix: Vec<f32> = (0..n)
            .map(|i| {
                let on = (i / span) % 2 == 0;
                let voice = if on {
                    0.3 * (2.0 * std::f32::consts::PI * 300.0 * i as f32 / SAMPLE_RATE as f32).sin()
                } else {
                    0.0
                };
                base[i] + voice
            })
            .collect();
        let mix = to_i16(&mix);
        let out_samples = process_all(&mut Processor::new(), true, &mix);
        let tail = n - SAMPLE_RATE as usize;
        let (mut on_in, mut on_out) = (vec![], vec![]);
        for k in 0..5 {
            let ini = tail + k * span;
            if (ini / span) % 2 == 0 {
                on_in.extend_from_slice(&mix[ini..ini + span]);
                on_out.extend_from_slice(&out_samples[ini..ini + span]);
            }
        }
        let change = db(rms(&on_out), rms(&on_in));
        assert!(change.abs() <= 6.0, "la voz cambió {change:.1} dB");
    }

    /// Por qué el medidor y el «estás hablando» van detrás del procesado: el
    /// ruido crudo pasa el umbral de voz y el procesado no. Medidos antes, un
    /// ventilador encendía el aro de hablar.
    #[test]
    fn a_fan_is_not_speech() {
        let (input, out_samples) = noise_in_and_out();
        let tail = input.len() - SAMPLES_PER_FRAME;
        assert!(has_voice(&input[tail..]), "el ruido crudo ya no pasa el umbral: la prueba no prueba nada");
        assert!(!has_voice(&out_samples[tail..]), "el ruido procesado cuenta como voz");
    }

    #[test]
    fn off_leaves_the_frame_alone_and_drops_the_module() {
        let mut seed = 3;
        let input = to_i16(&noise(SAMPLES_PER_FRAME * 4, 0.05, &mut seed));
        let mut p = Processor::new();
        process_all(&mut p, true, &input);
        assert!(p.apm.is_some());
        let out_samples = process_all(&mut p, false, &input);
        assert_eq!(out_samples, input);
        assert!(p.apm.is_none(), "al volver a encender tiene que empezar limpio");
    }

    /// `process_stream` hace panic con una longitud que no es múltiplo de
    /// 10 ms; aquí tiene que ser un error y la trama, intacta.
    #[test]
    fn a_bad_frame_does_not_kill_capture() {
        let mut p = Processor::new();
        let mut cut = vec![100i16; SAMPLES_PER_FRAME - 1];
        let before = cut.clone();
        assert!(p.process_frame(true, &mut cut, vec![]).is_err());
        assert_eq!(cut, before);
        assert!(p.process_frame(true, &mut [], vec![]).is_err());
    }

    /// El orden en la captura: procesar, y después medir el pico y la voz. Se
    /// lee el fuente porque ese orden vive dentro de una tarea con un micrófono
    /// de verdad, que ninguna prueba abre (como `no_loop_keeps_its_own_channel`).
    #[test]
    fn capture_processes_before_measuring() {
        let source_handle = include_str!("voice.rs");
        let ini = source_handle.find("fn start_capture_thread(").unwrap();
        let body = &source_handle[ini..];
        let processes = body.find("processor.process_frame(").expect("la captura no procesa");
        let peak = body.find("peak_permille(&samples)").expect("la captura no mide el pico");
        let voice = body.find("has_voice(&samples)").expect("la captura no mira si hablas");
        let sends = body.find("source_handle.capture_frame(").unwrap();
        assert!(processes < peak && processes < voice && processes < sends);
    }
}

/// El eco: una sola salida que suma a todos y deja lo que suena de referencia
/// para el cancelador. Mutantes: dar la vuelta al sumar en vez de recortar;
/// guardar la referencia sin tope o tirando lo nuevo; volver a abrir un
/// altavoz por pista (sin mezcla no hay referencia); crear el módulo sin eco,
/// o con el control de ganancia (que deshace la supresión del ruido).
#[cfg(test)]
mod echo_tests {
    use super::*;

    /// Tramas de 10 ms que llegan a trompicones —dos de golpe, luego nada—
    /// mientras la tarjeta consume a ritmo fijo: con el colchón, ni un hueco.
    /// Sin él (la v1.6.101), un hueco cada vez que la tarjeta llegaba antes.
    #[test]
    fn a_jittery_track_leaves_no_gaps() {
        let mut p = MixTrack::default();
        let rtc_frame = vec![1000i16; SAMPLES_PER_FRAME];
        let mut out_samples = Vec::new();
        for step in 0..200 {
            // Llegan de dos en dos cada 20 ms; la tarjeta pide 10 ms cada 10 ms.
            if step % 2 == 0 {
                p.push_samples(&rtc_frame);
                p.push_samples(&rtc_frame);
            }
            for _ in 0..SAMPLES_PER_FRAME {
                out_samples.push(p.next_sample());
            }
        }
        assert_eq!(p.gaps, 0, "la pista se vació sonando");
        // Al principio espera al colchón, y después no vuelve a callar.
        let starts = out_samples.iter().position(|&m| m != 0).unwrap();
        assert!(out_samples[starts..].iter().all(|&m| m != 0), "un silencio a mitad: un clic");
    }

    #[test]
    fn without_cushion_it_waits_and_after_a_gap_waits_again() {
        let mut p = MixTrack::default();
        p.push_samples(&vec![5i16; JITTER_CUSHION - 1]);
        assert_eq!(p.next_sample(), 0, "con menos del colchón todavía no suena");
        p.push_samples(&[5]);
        assert_eq!(p.next_sample(), 5);
        while !p.queue.is_empty() {
            p.next_sample();
        }
        assert_eq!(p.next_sample(), 0);
        assert_eq!(p.gaps, 1);
        p.push_samples(&[7; 10]);
        assert_eq!(p.next_sample(), 0, "tras un hueco vuelve a esperar el colchón, no suelta muestras sueltas");
    }

    #[test]
    fn the_queue_is_bounded_and_keeps_the_latest() {
        let mut p = MixTrack::default();
        let plenty: Vec<i16> = (0..(QUEUE_MAX as i32 + 10)).map(|i| (i % 30_000) as i16).collect();
        p.push_samples(&plenty);
        assert!(p.queue.len() <= QUEUE_MAX);
        assert_eq!(p.queue.back().copied(), plenty.last().copied());
    }

    #[test]
    fn stereo_is_averaged_to_mono() {
        assert_eq!(to_mono(&[100, 300, -50, 50], 2), vec![200, 0]);
        assert_eq!(to_mono(&[1, 2, 3], 1), vec![1, 2, 3]);
    }

    /// El diario en disco: se añade, y al pasar del tope el viejo se queda
    /// como `.1` y se empieza otro. Mutantes: sobrescribir en vez de añadir;
    /// no rotar.
    #[test]
    fn the_diary_is_saved_and_rotates() {
        let dir = std::env::temp_dir().join(format!("cac-diario-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path_buf = dir.join("voice.log");
        write_diary(&path_buf, "uno", 1000);
        write_diary(&path_buf, "dos", 1000);
        assert_eq!(std::fs::read_to_string(&path_buf).unwrap(), "uno\ndos\n");
        write_diary(&path_buf, &"x".repeat(2000), 1000);
        write_diary(&path_buf, "tres", 1000);
        assert_eq!(std::fs::read_to_string(&path_buf).unwrap(), "tres\n");
        assert!(std::fs::read_to_string(path_buf.with_extension("log.1")).unwrap().starts_with("uno\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_loud_voices_clip_instead_of_wrapping() {
        assert_eq!(mix_samples([1000i16, -300, 50].into_iter()), 750);
        assert_eq!(mix_samples([30_000i16, 30_000].into_iter()), i16::MAX);
        assert_eq!(mix_samples([-30_000i16, -30_000].into_iter()), i16::MIN);
        assert_eq!(mix_samples(std::iter::empty()), 0);
    }

    #[test]
    fn the_reference_keeps_the_latest_and_is_bounded() {
        let mut queue = std::collections::VecDeque::new();
        let plenty: Vec<i16> = (0..(RENDER_REFERENCE_MAX as i32 + 100)).map(|i| (i % 30_000) as i16).collect();
        note_reference(&mut queue, &plenty);
        assert_eq!(queue.len(), RENDER_REFERENCE_MAX);
        // Lo que se tira es lo viejo: lo último que sonó es lo que el micro
        // está a punto de recoger.
        assert_eq!(queue.back().copied(), plenty.last().copied());
        assert_eq!(queue.front().copied(), Some(plenty[100]));
    }

    #[test]
    fn the_reference_comes_in_10_ms_frames_and_the_rest_waits() {
        let mut queue: std::collections::VecDeque<i16> =
            std::iter::repeat_n(7i16, SAMPLES_PER_FRAME * 2 + 5).collect();
        let frames = frames_of(&mut queue);
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|t| t.len() == SAMPLES_PER_FRAME));
        assert_eq!(queue.len(), 5);
    }

    /// Lo que suena vuelve al micro a −10 dB y 30 ms tarde, como unos
    /// altavoces en la mesa. Con la referencia, el último segundo de seis baja
    /// 69 dB (medido al escribirlo); sin ella, 4. El umbral deja margen.
    #[test]
    fn speaker_echo_is_cancelled() {
        let mut seed: u32 = 11;
        let n = SAMPLE_RATE as usize * 6;
        // Voz de mentira: ruido a ráfagas, con silencios entre medias.
        let sounds: Vec<i16> = (0..n)
            .map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let env = if (i / 9600) % 3 == 2 { 0.0 } else { 0.4 };
                (((seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * env * i16::MAX as f32) as i16
            })
            .collect();
        let delay = SAMPLE_RATE as usize * 30 / 1000;
        let mic: Vec<i16> = (0..n)
            .map(|i| if i >= delay { (sounds[i - delay] as f32 * 0.3) as i16 } else { 0 })
            .collect();
        let mut p = Processor::new();
        let mut out_samples = Vec::with_capacity(n);
        for (k, t) in mic.chunks(SAMPLES_PER_FRAME).enumerate() {
            let reference = sounds[k * SAMPLES_PER_FRAME..(k + 1) * SAMPLES_PER_FRAME].to_vec();
            let mut t = t.to_vec();
            p.process_frame(true, &mut t, vec![reference]).unwrap();
            out_samples.extend(t);
        }
        let rms = |x: &[i16]| (x.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt();
        let u = n - SAMPLE_RATE as usize;
        let drops_db = 20.0 * (rms(&out_samples[u..]).max(1e-6) / rms(&mic[u..])).log10();
        assert!(drops_db <= -30.0, "el eco sólo bajó {drops_db:.1} dB");
    }

    /// Lo que hace posible cancelar: nadie suena por su cuenta. Lee su propio
    /// fichero, como `no_loop_keeps_its_own_channel`.
    #[test]
    fn everything_plays_through_one_output_and_cancels_echo() {
        let source_handle = include_str!("voice.rs");
        let stop = source_handle.find("#[cfg(test)]").unwrap_or(source_handle.len());
        let code = &source_handle[..stop];
        assert_eq!(
            code.matches(".build_output_stream(").count(),
            1,
            "un altavoz por pista deja al cancelador sin saber qué suena"
        );
        let output = code.find("fn ensure_output()").unwrap();
        let opens = code.find(".build_output_stream(").unwrap();
        assert!(opens > output, "la única salida es la del mezclador");
        // Y la salida saca por el colchón, y la pista mete por él y a mono:
        // sin esto, la pieza probada arriba no es la que suena.
        let output_fn = &code[output..code[output..].find("\nfn close_output").unwrap() + output];
        assert!(output_fn.contains("q.next_sample()"), "la salida no usa el colchón de cada pista");
        let track_fn = &code[code.find("fn play_track(").unwrap()..];
        let track_fn = &track_fn[..track_fn.find("\n}\n").unwrap()];
        assert!(track_fn.contains("to_mono(") && track_fn.contains(".push_samples("), "la pista no mete por el colchón");
        assert!(
            code.contains("AudioProcessingModule::new(true, false, true, true)"),
            "el módulo tiene que crearse con el cancelador de eco encendido"
        );
        let processes = code.find("fn process_frame(&mut self").unwrap();
        let reverse = code[processes..].find("process_reverse_stream").unwrap();
        let direct = code[processes..].find("apm.process_stream").unwrap();
        assert!(reverse < direct, "la referencia va antes que la trama del micro");
        // Y la captura de verdad se la da: sin esto el cancelador está
        // encendido y no sabe qué restar.
        let capture = code.find("fn start_capture_thread(").unwrap();
        let call = code[capture..].find("processor.process_frame(").unwrap() + capture;
        let closing = code[call..].find(")?").or(code[call..].find(") {")).unwrap() + call;
        assert!(
            code[call..closing].contains("take_reference()"),
            "la captura no le pasa al cancelador lo que suena"
        );
    }
}

/// El formato del micrófono viaja con las claves que lee la página. Mutante:
/// quitar un `rename` (el diagnóstico diría «undefined Hz», como ya pasó).
#[cfg(test)]
mod wire_tests {
    use super::*;

    #[test]
    fn the_input_format_keeps_its_wire_keys() {
        let f = InputFormat {
            device: "m".into(), rate_hz: 44_100, channel_count: 2, format_name: "F32".into(),
            source_rate: 48_000, matches_rate: false,
        };
        let v = serde_json::to_value(&f).unwrap();
        for k in ["dispositivo", "ritmo", "canales", "formato", "ritmoDeLaFuente", "coincide"] {
            assert!(v.get(k).is_some(), "falta la clave «{k}» que lee la página: {v}");
        }
    }
}
