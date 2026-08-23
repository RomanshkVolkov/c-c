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
use livekit::track::{
    LocalAudioTrack, LocalTrack, LocalVideoTrack, RemoteTrack, TrackKind, TrackSource,
};
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::{AudioFrame, I420Buffer, VideoFrame, VideoResolution, VideoRotation};
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
const CANALES: u32 = 1;
/// 10 ms por trama, que es el tamaño que espera libwebrtc.
const MUESTRAS_POR_TRAMA: usize = SAMPLE_RATE as usize / 100;

/// A partir de qué energía se considera que alguien está hablando.
///
/// Sobre 1 en escala completa. Un 2 % deja fuera el ruido de fondo de una
/// habitación y el zumbido de un ventilador, y entra con voz normal a medio
/// metro del micrófono.
const UMBRAL_VOZ: f32 = 0.02;

/// Cuánto se mantiene encendido el indicador tras la última trama con voz.
///
/// Sin esto parpadea entre palabra y palabra —y entre sílabas— porque el
/// silencio de una coma también baja del umbral. Trescientos milisegundos es
/// más que la pausa de una frase y menos que la de un turno de conversación.
const COLA_VOZ: std::time::Duration = std::time::Duration::from_millis(300);

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
    /// Quién tiene el micrófono cerrado. Uno a uno y no la lista entera, porque
    /// aquí sí llega un evento por cambio y no un estado completo: el SDK avisa
    /// de la pista que se silencia, no de las que siguen igual.
    Muted { identity: String, muted: bool },
    /// Ida y vuelta al SFU, en milisegundos.
    Latency { ms: u32 },
    /// Esta persona está publicando vídeo, o dejó de hacerlo.
    ///
    /// `source` es `"camera"` o `"screen"`, y no sobra: una persona puede
    /// publicar las dos a la vez, y la pantalla compartida no va en su mosaico
    /// sino ocupando el escenario.
    Video { identity: String, source: String, enabled: bool },
    /// **Tú** estás hablando, medido de tu propio micrófono.
    ///
    /// Va aparte de `Speaking` a propósito. Aquélla es la lista que manda el
    /// servidor, que tarda su medio segundo en decidirla y —según cómo esté
    /// configurado el observador de niveles— puede no incluirte a ti nunca. Tu
    /// propio recuadro no debería depender de que un servidor opine sobre algo
    /// que está pasando en tu mesa.
    SelfSpeaking { speaking: bool },
    Disconnected { reason: String },
}

struct VoiceSession {
    room: Arc<Room>,
    /// Se retienen para que la captura siga viva: soltar el stream de cpal lo
    /// para, y soltar la fuente corta lo que se publica.
    // Mutable: cambiar de micrófono la sustituye sin salirse de la llamada.
    _captura: StreamGuard,
    fuente: NativeAudioSource,
    /// La pista publicada, para poder silenciarla **en la pista** y no sólo en
    /// las muestras. Ver `voice_set_mic`.
    micro: LocalAudioTrack,
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
            LocalTrack::Audio(pista.clone()),
            TrackPublishOptions { source: TrackSource::Microphone, ..Default::default() },
        )
        .await
        .map_err(|e| format!("no se pudo publicar el micrófono: {e}"))?;

    *CANAL.lock().unwrap() = Some(on_event.clone());
    *YO.lock().unwrap() = Some(identidad.clone());
    nota(format!("sala: dentro como {identidad}"));
    let captura = arrancar_captura(fuente.clone(), on_event.clone())?;

    on_event
        .send(VoiceEvent::Connected { identity: identidad.clone() })
        .map_err(|e| e.to_string())?;

    *SESION.lock().unwrap() = Some(VoiceSession {
        room: room.clone(),
        _captura: captura,
        fuente,
        micro: pista,
    });

    escuchar_eventos(eventos, on_event.clone());
    medir_latencia(Arc::downgrade(&room), on_event);
    Ok(identidad)
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
    if YO.lock().unwrap().is_some() {
        nota("sala: fuera");
    }
    CAMARA.store(false, Relaxed);
    PANTALLA.store(false, Relaxed);
    // Las caras de la sala anterior no se heredan.
    crate::video_frames::olvidar_todo();
    *YO.lock().unwrap() = None;
    // La sordera no se hereda: entrar a otra sala sin oír a nadie, y sin que la
    // pantalla lo diga porque el store ya se vació, es un fallo mudo.
    SORDO.store(false, std::sync::atomic::Ordering::Relaxed);
    let sesion = SESION.lock().unwrap().take();
    if let Some(s) = sesion {
        // El guard de captura muere con `s` y con él el hilo del micrófono.
        let _ = s.room.close().await;
    }
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
    let micro = {
        let guard = SESION.lock().unwrap();
        match guard.as_ref() {
            Some(s) => s.micro.clone(),
            None => return Err("no estás en ninguna sala".into()),
        }
    };
    SILENCIADO.store(!enabled, std::sync::atomic::Ordering::Relaxed);
    nota(if enabled { "micro: abierto" } else { "micro: silenciado" });
    if enabled {
        micro.unmute();
    } else {
        micro.mute();
    }
    Ok(())
}

/// Silenciar de verdad: la captura sigue corriendo y lo que se publica es
/// silencio. Parar el dispositivo daría un corte audible al volver.
static SILENCIADO: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
static MIC_ELEGIDO: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
static CAM_ELEGIDA: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// Un dispositivo, tal como lo enseña la pantalla.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispositivo {
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
    let elegido = MIC_ELEGIDO.lock().unwrap().clone();
    let por_defecto = host.default_input_device().and_then(|d| id_de(&d));
    let actual_mic = elegido.clone().or(por_defecto);

    let todos: Vec<Dispositivo> = host
        .input_devices()
        .map_err(|e| format!("no se pudieron listar los micrófonos: {e}"))?
        .filter_map(|d| {
            let id = id_de(&d)?;
            Some(Dispositivo {
                current: Some(&id) == actual_mic.as_ref(),
                id,
                // En cpal 0.18 el nombre legible es el `Display` del propio
                // dispositivo; `name()` ya no existe.
                name: d.to_string(),
            })
        })
        .collect();
    let mics = limpiar(todos);

    let elegida = CAM_ELEGIDA.lock().unwrap().clone();
    let camaras = nokhwa::query(nokhwa::utils::ApiBackend::Auto).unwrap_or_default();
    let primera = camaras.first().map(|c| c.human_name());
    let actual_cam = elegida.clone().or(primera);
    // Sin repetidas: una webcam suele aparecer dos veces —`/dev/video0` captura
    // y `/dev/video1` metadatos— con el mismo nombre. Salían las dos, y las dos
    // con la marca de «puesta», que además era mentira.
    let cams = sin_repetidos(
        camaras
            .into_iter()
            .map(|c| {
                let name = c.human_name();
                Dispositivo { current: Some(&name) == actual_cam.as_ref(), id: name.clone(), name }
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
            *MIC_ELEGIDO.lock().unwrap() = Some(device_id);
            let fuente = {
                let guard = SESION.lock().unwrap();
                guard.as_ref().map(|s| s.fuente.clone())
            };
            // Fuera de una llamada sólo se apunta la preferencia, que es lo que
            // hará falta en la siguiente.
            let Some(fuente) = fuente else { return Ok(()) };
            let canal = CANAL.lock().unwrap().clone();
            let nueva = arrancar_captura(fuente, canal.ok_or("no hay canal de eventos")?)?;
            // Se sustituye **después** de que la nueva arranque: si se soltara
            // antes y la nueva fallara, la llamada se quedaría muda sin que
            // nadie hubiera pedido eso.
            if let Some(s) = SESION.lock().unwrap().as_mut() {
                s._captura = nueva;
            }
            Ok(())
        }
        "cam" => {
            *CAM_ELEGIDA.lock().unwrap() = Some(device_id);
            if CAMARA.load(std::sync::atomic::Ordering::Relaxed) {
                voice_set_camera(false).await?;
                voice_set_camera(true).await?;
            }
            Ok(())
        }
        otro => Err(format!("no sé cambiar «{otro}»")),
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
fn limpiar(todos: Vec<Dispositivo>) -> Vec<Dispositivo> {
    let utiles: Vec<Dispositivo> = todos
        .iter()
        .filter(|d| es_util(&d.id))
        .cloned()
        .collect();
    sin_repetidos(if utiles.is_empty() { todos } else { utiles })
}

/// El identificador viene como `<host>:<pcm>`; sólo el `pcm` dice qué es esto.
fn es_util(id: &str) -> bool {
    let Some((host, pcm)) = id.split_once(':') else { return true };
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
fn sin_repetidos(lista: Vec<Dispositivo>) -> Vec<Dispositivo> {
    let mut vistos = std::collections::HashSet::new();
    lista.into_iter().filter(|d| vistos.insert(d.name.clone())).collect()
}

/// El identificador estable de un dispositivo de audio, como texto.
fn id_de(d: &cpal::Device) -> Option<String> {
    d.id().ok().map(|i| i.to_string())
}

// ─── El diario del motor ──────────────────────────────────────────────────────

/// Cuántas líneas se guardan. Trescientas cubren de sobra una llamada entera
/// contada por cambios de estado; más sería guardar para nadie.
const DIARIO_MAX: usize = 300;

static DIARIO: LazyLock<Mutex<std::collections::VecDeque<String>>> =
    LazyLock::new(|| Mutex::new(std::collections::VecDeque::with_capacity(DIARIO_MAX)));

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
pub fn nota(linea: impl AsRef<str>) {
    let linea = linea.as_ref();
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() % 86_400)
        .unwrap_or(0);
    let sello = format!("{:02}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60);
    // También a la salida de error: quien tenga la app en una terminal lo ve
    // en vivo, sin abrir ninguna pantalla.
    eprintln!("voz {sello} · {linea}");
    let mut d = DIARIO.lock().unwrap();
    if d.len() == DIARIO_MAX {
        d.pop_front();
    }
    d.push_back(format!("{sello} · {linea}"));
}

/// El diario, lo más reciente al final.
///
/// `async` porque lo exige la regla de `voice_set_mic` — y aunque éste no toca
/// el SDK, la excepción hay que escribirla a mano y no vale la pena.
#[tauri::command]
pub async fn voice_diagnostics() -> Vec<String> {
    DIARIO.lock().unwrap().iter().cloned().collect()
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
static YO: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// El canal de eventos de la sesión en curso, para poder rearrancar la captura
/// sin que el llamante tenga que pasarlo.
static CANAL: LazyLock<Mutex<Option<Channel<VoiceEvent>>>> = LazyLock::new(|| Mutex::new(None));

/// Sordera: lo que llega se descarta al pintarlo en el altavoz.
///
/// Se apaga aquí y no cerrando los streams de reproducción porque las pistas de
/// los demás siguen llegando mientras tanto: si se cerraran, quitar la sordera
/// exigiría reconstruir un stream por persona y los primeros segundos se
/// perderían. Un booleano en el callback cuesta nada y vuelve al instante.
static SORDO: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Dejar de oír. Silenciar el micrófono es cosa del que llama —ver el store—,
/// porque es una regla del producto y no del motor.
///
/// Síncrono a propósito y es de los pocos que puede serlo: escribe un booleano
/// atómico y nada más. No toca el SDK, así que no le aplica la regla de
/// `voice_set_mic`. Está en la lista de excepciones del test de abajo.
#[tauri::command]
pub fn voice_set_deaf(enabled: bool) -> Result<(), String> {
    SORDO.store(enabled, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Al cerrar la ventana. Sin esto queda una sala abierta y un micrófono vivo en
/// un proceso que ya nadie mira — la misma lección que el pty.
pub fn close_all() {
    // Igual que al colgar: sin esto la ventana se cierra y los hilos de la
    // cámara y la pantalla siguen vivos en un proceso que ya nadie mira.
    use std::sync::atomic::Ordering::Relaxed;
    CAMARA.store(false, Relaxed);
    PANTALLA.store(false, Relaxed);
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
fn arrancar_captura(
    fuente: NativeAudioSource,
    canal: Channel<VoiceEvent>,
) -> Result<StreamGuard, String> {
    let (fin_tx, fin_rx) = std::sync::mpsc::channel::<()>();
    let (listo_tx, listo_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        let host = cpal::default_host();
        // El elegido a mano si lo hay y sigue existiendo; si se desenchufó, el
        // del sistema. Caer al del sistema es mejor que negarse a hablar.
        let elegido = MIC_ELEGIDO.lock().unwrap().clone();
        let dispositivo = elegido
            .and_then(|id| {
                host.input_devices().ok()?.find(|d| id_de(d).as_ref() == Some(&id))
            })
            .or_else(|| host.default_input_device());
        let dispositivo = match dispositivo {
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
            // ¿Estás hablando? Se mide aquí, sobre las mismas muestras que se
            // publican, en vez de esperar a que el servidor lo diga: es
            // inmediato, funciona aunque estés solo en la sala, y no depende de
            // cómo esté configurado el observador de niveles del SFU.
            let mut hablando = false;
            let mut ultima_voz = std::time::Instant::now();

            while let Some(datos) = tramas_rx.recv().await {
                if hay_voz(&datos) {
                    ultima_voz = std::time::Instant::now();
                }
                // La cola es lo que evita el parpadeo entre sílabas.
                let ahora = hablando_ahora(&datos, ultima_voz);
                if ahora != hablando {
                    hablando = ahora;
                    if canal.send(VoiceEvent::SelfSpeaking { speaking: ahora }).is_err() {
                        break; // la pantalla se fue
                    }
                }

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
/// Con las muestras puestas a cero por `SILENCIADO`, esto da cero solo:
/// silenciarse apaga el indicador sin ningún caso especial.
fn hay_voz(muestras: &[i16]) -> bool {
    if muestras.is_empty() {
        return false;
    }
    let suma: f64 = muestras.iter().map(|&m| { let v = m as f64; v * v }).sum();
    let rms = (suma / muestras.len() as f64).sqrt() / i16::MAX as f64;
    rms as f32 > UMBRAL_VOZ
}

/// El estado con la cola aplicada: hay voz ahora, o la hubo hace poco.
fn hablando_ahora(muestras: &[i16], ultima_voz: std::time::Instant) -> bool {
    hay_voz(muestras) || ultima_voz.elapsed() < COLA_VOZ
}

/// Traduce los eventos de la sala a lo que la pantalla entiende, y reproduce lo
/// que dicen los demás.
fn escuchar_eventos(mut eventos: mpsc::UnboundedReceiver<RoomEvent>, canal: Channel<VoiceEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = eventos.recv().await {
            let enviado = match ev {
                // Los que ya estaban cuando llegaste.
                //
                // El SDK **no** manda `ParticipantConnected` por ellos: vienen
                // en la respuesta de entrada y sólo aparecen aquí. Sin este
                // brazo, entrar a una conversación en curso enseñaba una sala
                // vacía hasta que alguien se movía — que es justo la vez que
                // más importa ver quién hay.
                RoomEvent::Connected { participants_with_tracks } => {
                    let mut r = Ok(());
                    for (p, pistas) in participants_with_tracks {
                        let identity = p.identity().to_string();
                        r = r.and(canal.send(VoiceEvent::Joined {
                            identity: identity.clone(),
                            name: p.name().to_string(),
                        }));
                        // Y su micrófono, que también es estado de partida: si
                        // sólo se reportara al cambiar, quien entró mudo se
                        // vería abierto hasta que se le ocurriera hablar.
                        for pista in pistas {
                            if pista.kind() == TrackKind::Audio {
                                r = r.and(canal.send(VoiceEvent::Muted {
                                    identity: identity.clone(),
                                    muted: pista.is_muted(),
                                }));
                            }
                        }
                    }
                    r
                }
                RoomEvent::ParticipantConnected(p) => canal.send(VoiceEvent::Joined {
                    identity: p.identity().to_string(),
                    name: p.name().to_string(),
                }),
                RoomEvent::ParticipantDisconnected(p) => {
                    // Su última cara se va con ella: si no, el mosaico
                    // siguiente que reutilice ese hueco enseñaría a quien ya
                    // se fue.
                    crate::video_frames::olvidar_persona(&p.identity().to_string());
                    canal.send(VoiceEvent::Left { identity: p.identity().to_string() })
                }
                RoomEvent::ActiveSpeakersChanged { speakers } => canal.send(VoiceEvent::Speaking {
                    identities: speakers.iter().map(|s| s.identity().to_string()).collect(),
                }),
                RoomEvent::TrackMuted { participant, publication }
                | RoomEvent::TrackUnmuted { participant, publication } => {
                    // El propio también llega por aquí, y se deja pasar: la
                    // pantalla ya lo pintó de forma optimista al pulsar, y esto
                    // es la confirmación de que el servidor se enteró.
                    if publication.kind() == TrackKind::Audio {
                        canal.send(VoiceEvent::Muted {
                            identity: participant.identity().to_string(),
                            muted: publication.is_muted(),
                        })
                    } else {
                        Ok(())
                    }
                }
                // Alguien publica un micrófono estando ya dentro —se reconectó,
                // o cambió de dispositivo—: su estado de partida otra vez.
                RoomEvent::TrackPublished { publication, participant } => {
                    if publication.kind() == TrackKind::Audio {
                        canal.send(VoiceEvent::Muted {
                            identity: participant.identity().to_string(),
                            muted: publication.is_muted(),
                        })
                    } else {
                        Ok(())
                    }
                }
                RoomEvent::TrackSubscribed { track, publication, participant } => {
                    let identidad = participant.identity().to_string();
                    match track {
                        RemoteTrack::Audio(audio) => {
                            reproducir(audio.rtc_track());
                            Ok(())
                        }
                        RemoteTrack::Video(video) => {
                            let fuente = fuente_de(publication.source());
                            nota(format!("llega {} de {identidad}", fuente.como_texto()));
                            recibir_video(identidad.clone(), fuente, video.rtc_track());
                            canal.send(VoiceEvent::Video {
                                identity: identidad,
                                source: fuente.como_texto().into(),
                                enabled: true,
                            })
                        }
                    }
                }
                RoomEvent::TrackUnsubscribed { track, publication, participant } => {
                    if matches!(track, RemoteTrack::Video(_)) {
                        let identidad = participant.identity().to_string();
                        let fuente = fuente_de(publication.source());
                        nota(format!("se va {} de {identidad}", fuente.como_texto()));
                        crate::video_frames::olvidar(&identidad, fuente);
                        canal.send(VoiceEvent::Video {
                            identity: identidad,
                            source: fuente.como_texto().into(),
                            enabled: false,
                        })
                    } else {
                        Ok(())
                    }
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

/// Cada cuánto se pregunta el ida y vuelta. Cinco segundos: es un número para
/// mirar de reojo cuando la llamada va rara, no un gráfico.
const CADA_LATENCIA: std::time::Duration = std::time::Duration::from_secs(5);

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
fn medir_latencia(sala: std::sync::Weak<Room>, canal: Channel<VoiceEvent>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CADA_LATENCIA).await;
            let Some(room) = sala.upgrade() else { break };
            let Ok(stats) = room.get_stats().await else { break };

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
            if canal.send(VoiceEvent::Latency { ms: (rtt * 1000.0).round() as u32 }).is_err() {
                break;
            }
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
fn recibir_video(
    identidad: String,
    fuente: crate::video_frames::Fuente,
    pista: livekit::webrtc::prelude::RtcVideoTrack,
) {
    tauri::async_runtime::spawn(async move {
        let mut entrante = NativeVideoStream::new(pista);
        while let Some(trama) = entrante.next().await {
            let (ancho, alto) = (trama.buffer.width(), trama.buffer.height());
            crate::video_frames::guardar(&identidad, fuente, &trama.buffer.to_i420(), ancho, alto);
        }
        // El stream se acaba cuando la pista se va; el `olvidar` del evento
        // llega por su lado, y repetirlo aquí no hace daño.
        crate::video_frames::olvidar(&identidad, fuente);
    });
}

/// Lo que el SFU llama fuente, en nuestros términos.
///
/// Todo lo que no se anuncia como pantalla se trata como cara. Es la caída
/// segura: una fuente desconocida en un mosaico es raro, y en el escenario a
/// pantalla completa taparía la conversación.
fn fuente_de(source: TrackSource) -> crate::video_frames::Fuente {
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
                let sordo = SORDO.load(std::sync::atomic::Ordering::Relaxed);
                for trozo in salida.chunks_mut(salida_canales) {
                    // Silencio cuando la cola se vacía: es preferible un hueco
                    // a repetir la última muestra, que suena a chirrido.
                    //
                    // Sordo también consume la muestra en vez de saltarse el
                    // `pop`: si no, la cola crece mientras no oyes y al volver
                    // sonaría lo de hace un minuto.
                    let v = q.pop_front().map(|s| s as f32 / i16::MAX as f32).unwrap_or(0.0);
                    let v = if sordo { 0.0 } else { v };
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
        // Y se borra la última trama propia: sin esto, apagar la cámara deja tu
        // cara congelada en tu propio mosaico, que es peor que no verse.
        if let Some(yo) = YO.lock().unwrap().clone() {
            crate::video_frames::olvidar(&yo, crate::video_frames::Fuente::Camara);
        }
        return Ok(estado_video());
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
    CAMARA.store(true, std::sync::atomic::Ordering::Relaxed);
    let (fuente, ancho, alto) = arrancar_camara().inspect_err(|_| {
        CAMARA.store(false, std::sync::atomic::Ordering::Relaxed);
    })?;
    nota(format!("cámara: publicada a {ancho}x{alto}"));
    let pista = LocalVideoTrack::create_video_track("camara", RtcVideoSource::Native(fuente));
    room.local_participant()
        .publish_track(
            LocalTrack::Video(pista),
            TrackPublishOptions { source: TrackSource::Camera, ..Default::default() },
        )
        .await
        .map_err(|e| {
            CAMARA.store(false, std::sync::atomic::Ordering::Relaxed);
            format!("no se pudo publicar la cámara: {e}")
        })?;
    Ok(estado_video())
}

static CAMARA: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PANTALLA: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
#[tauri::command]
pub async fn voice_share_screen() -> Result<VideoState, String> {
    let room = {
        let guard = SESION.lock().unwrap();
        match guard.as_ref() {
            Some(s) => s.room.clone(),
            None => return Err("no estás en ninguna sala".into()),
        }
    };
    if PANTALLA.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(estado_video());
    }

    // La resolución la dicta la pantalla que el sistema conceda, así que la
    // fuente se crea con la de la primera trama. Hasta que llegue no hay nada
    // que publicar — y publicar una pista muerta deja a los demás mirando un
    // rectángulo negro mientras alguien decide en el diálogo del portal.
    let (fuente, ancho, alto) = arrancar_pantalla()?;

    let pista = LocalVideoTrack::create_video_track("pantalla", RtcVideoSource::Native(fuente));
    room.local_participant()
        .publish_track(
            LocalTrack::Video(pista),
            TrackPublishOptions { source: TrackSource::Screenshare, ..Default::default() },
        )
        .await
        .map_err(|e| {
            PANTALLA.store(false, std::sync::atomic::Ordering::Relaxed);
            format!("no se pudo publicar la pantalla: {e}")
        })?;
    nota(format!("pantalla: publicada a {ancho}x{alto}"));
    Ok(estado_video())
}

/// Dejar de compartir.
#[tauri::command]
pub async fn voice_stop_share() -> Result<VideoState, String> {
    let room = {
        let guard = SESION.lock().unwrap();
        match guard.as_ref() {
            Some(s) => s.room.clone(),
            None => return Err("no estás en ninguna sala".into()),
        }
    };
    // Primero la bandera: es la que para el hilo de captura, y pararlo antes de
    // despublicar evita que siga entregando tramas a una pista que ya no está.
    PANTALLA.store(false, std::sync::atomic::Ordering::Relaxed);
    despublicar(&room, TrackSource::Screenshare).await;
    if let Some(yo) = YO.lock().unwrap().clone() {
        crate::video_frames::olvidar(&yo, crate::video_frames::Fuente::Pantalla);
    }
    Ok(estado_video())
}

/// Cuánto se espera a que alguien conteste al diálogo del sistema.
///
/// Un minuto y no diez segundos: entre que aparece el diálogo, se busca la
/// ventana correcta y se acepta, pasa más tiempo del que parece — y rendirse
/// mientras el usuario está eligiendo es el peor momento posible.
const ESPERA_PORTAL: std::time::Duration = std::time::Duration::from_secs(60);

/// La pantalla del sistema, en su propio hilo.
///
/// Devuelve la fuente ya alimentada con la primera trama, más sus medidas. Se
/// espera a esa primera trama a propósito: es lo único que demuestra que el
/// sistema concedió el permiso, y es lo que permite crear la pista con el
/// tamaño de verdad en vez de adivinarlo.
fn arrancar_pantalla() -> Result<(NativeVideoSource, u32, u32), String> {
    use livekit::webrtc::desktop_capturer::{
        DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
    };

    let (primera_tx, primera_rx) = std::sync::mpsc::channel::<Result<(u32, u32), String>>();
    let (fuente_tx, fuente_rx) = std::sync::mpsc::channel::<NativeVideoSource>();

    std::thread::spawn(move || {
        let mut opciones = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
        // El cursor dentro de la imagen. Compartir una pantalla para señalar
        // algo sin que se vea el puntero es media función.
        opciones.set_include_cursor(true);
        let Some(mut cap) = DesktopCapturer::new(opciones) else {
            nota("pantalla: este sistema no trae capturador");
            let _ = primera_tx.send(Err("este sistema no sabe capturar la pantalla".into()));
            return;
        };
        // En Wayland la lista trae una entrada de relleno y la elección real la
        // hace el portal; en Windows y macOS es la pantalla principal. Elegir
        // aquí una concreta sería adelantarse a lo que el sistema va a preguntar.
        let fuentes = cap.get_source_list();
        nota(format!("pantalla: pidiendo permiso ({} fuentes enumeradas)", fuentes.len()));
        let (envio, recibo) = std::sync::mpsc::channel();
        cap.start_capture(fuentes.first().cloned(), move |r| {
            let _ = envio.send(r.map(|f| (f.width() as u32, f.height() as u32, f.data().to_vec())));
        });

        PANTALLA.store(true, std::sync::atomic::Ordering::Relaxed);
        let limite = std::time::Instant::now() + ESPERA_PORTAL;
        let mut fuente: Option<NativeVideoSource> = None;

        // A ritmo de vídeo, nunca en bucle cerrado: pedir tramas a un millón por
        // segundo no deja trabajar al hilo que tiene que producirlas, y el
        // capturador contesta «todavía no» mientras tanto. Costó una tarde.
        let cada = std::time::Duration::from_millis(1000 / 30);
        while PANTALLA.load(std::sync::atomic::Ordering::Relaxed) {
            cap.capture_frame();
            let mut ultima = None;
            while let Ok(r) = recibo.try_recv() {
                ultima = Some(r);
            }
            match ultima {
                Some(Ok((w, h, bgra))) => {
                    let fte = fuente.get_or_insert_with(|| {
                        let f = NativeVideoSource::new(
                            VideoResolution { width: w, height: h },
                            // Pantalla, no cara: el SFU prioriza el detalle.
                            true,
                        );
                        nota(format!("pantalla: concedida, primera trama {w}x{h}"));
                        let _ = fuente_tx.send(f.clone());
                        let _ = primera_tx.send(Ok((w, h)));
                        f
                    });
                    let mut buffer = I420Buffer::new(w, h);
                    bgra_a_i420(&bgra, w, h, &mut buffer);
                    guardarme(crate::video_frames::Fuente::Pantalla, &buffer, w, h);
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
                        nota("pantalla: el sistema la denegó");
                        let _ = primera_tx.send(Err("el sistema no concedió la pantalla".into()));
                        break;
                    }
                }
                None => {}
            }
            if fuente.is_none() && std::time::Instant::now() > limite {
                nota("pantalla: nadie contestó al diálogo en un minuto");
                let _ = primera_tx.send(Err("nadie contestó al diálogo de compartir".into()));
                break;
            }
            std::thread::sleep(cada);
        }
        PANTALLA.store(false, std::sync::atomic::Ordering::Relaxed);
    });

    match primera_rx.recv_timeout(ESPERA_PORTAL + std::time::Duration::from_secs(5)) {
        Ok(Ok((w, h))) => {
            let fuente = fuente_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .map_err(|_| "la captura arrancó sin fuente".to_string())?;
            Ok((fuente, w, h))
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("la captura de pantalla no respondió".into()),
    }
}

/// Guarda una trama propia donde la interfaz las busca.
///
/// Cuesta una copia por trama, la misma que se paga por cada participante
/// remoto. Se paga siempre y no sólo cuando alguien mira, porque la alternativa
/// —un «¿hay alguien mirando?» que la captura tuviera que consultar— acopla el
/// hilo del vídeo a la interfaz para ahorrar un memcpy.
fn guardarme(fuente: crate::video_frames::Fuente, buffer: &I420Buffer, ancho: u32, alto: u32) {
    let Some(yo) = YO.lock().unwrap().clone() else { return };
    crate::video_frames::guardar(&yo, fuente, buffer, ancho, alto);
}

/// BGRA de la pantalla → I420.
///
/// El capturador de escritorio entrega **BGRA**, no RGB como la cámara: el
/// orden de los canales es el de los mapas de bits del sistema, y confundirlo
/// pinta a todo el mundo de azul. Misma aritmética BT.601 que `rgb_a_i420`,
/// leyendo los componentes al revés y saltándose el alfa.
fn bgra_a_i420(bgra: &[u8], ancho: u32, alto: u32, destino: &mut I420Buffer) {
    let (w, h) = (ancho as usize, alto as usize);
    let (sy, su, _sv) = destino.strides();
    let (y_plano, u_plano, v_plano) = destino.data_mut();

    for fila in 0..h {
        for col in 0..w {
            let i = (fila * w + col) * 4;
            let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
            y_plano[fila * sy as usize + col] =
                (0.257 * r + 0.504 * g + 0.098 * b + 16.0).clamp(0.0, 255.0) as u8;
        }
    }
    for fila in (0..h).step_by(2) {
        for col in (0..w).step_by(2) {
            let i = (fila * w + col) * 4;
            let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
            let cf = fila / 2;
            let cc = col / 2;
            u_plano[cf * su as usize + cc] =
                (-0.148 * r - 0.291 * g + 0.439 * b + 128.0).clamp(0.0, 255.0) as u8;
            v_plano[cf * su as usize + cc] =
                (0.439 * r - 0.368 * g - 0.071 * b + 128.0).clamp(0.0, 255.0) as u8;
        }
    }
}

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
fn arrancar_camara() -> Result<(NativeVideoSource, u32, u32), String> {
    use nokhwa::pixel_format::RgbFormat;
    use nokhwa::utils::{CameraIndex, RequestedFormat, RequestedFormatType, Resolution};
    use nokhwa::Camera;

    let (listo_tx, listo_rx) = std::sync::mpsc::channel::<Result<(u32, u32), String>>();
    let (fuente_tx, fuente_rx) = std::sync::mpsc::channel::<NativeVideoSource>();
    std::thread::spawn(move || {
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
        let intentos: [(&str, RequestedFormatType); 4] = [
            ("720p", RequestedFormatType::HighestResolution(Resolution::new(VIDEO_ANCHO, VIDEO_ALTO))),
            ("480p", RequestedFormatType::HighestResolution(Resolution::new(640, 480))),
            ("más fps", RequestedFormatType::AbsoluteHighestFrameRate),
            ("la mayor", RequestedFormatType::AbsoluteHighestResolution),
        ];
        // Igual que el micrófono: la elegida por nombre, y si ya no está, la
        // primera. El índice se resuelve ahora y no se guarda, porque enchufar
        // otra cámara los renumera.
        let indice = CAM_ELEGIDA
            .lock()
            .unwrap()
            .clone()
            .and_then(|nombre| {
                nokhwa::query(nokhwa::utils::ApiBackend::Auto)
                    .ok()?
                    .into_iter()
                    .find(|c| c.human_name() == nombre)
                    .map(|c| c.index().clone())
            })
            .unwrap_or(CameraIndex::Index(0));
        let mut camara = None;
        let mut porques = Vec::new();
        for (nombre, tipo) in intentos {
            match Camera::new(indice.clone(), RequestedFormat::new::<RgbFormat>(tipo)) {
                Ok(mut c) => match c.open_stream() {
                    Ok(()) => {
                        nota(format!("cámara: abierta pidiendo «{nombre}» → {}", c.camera_format()));
                        camara = Some(c);
                        break;
                    }
                    Err(e) => {
                        nota(format!("cámara: «{nombre}» abrió pero no arrancó: {e}"));
                        porques.push(format!("{nombre}: {e}"));
                    }
                },
                Err(e) => {
                    nota(format!("cámara: «{nombre}» no está disponible: {e}"));
                    porques.push(format!("{nombre}: {e}"));
                }
            }
        }
        let Some(mut camara) = camara else {
            let _ = listo_tx.send(Err(format!(
                "la cámara no aceptó ningún formato ({})",
                porques.join("; ")
            )));
            return;
        };

        // La fuente nace con la primera trama, y con **sus** medidas. Hasta
        // entonces no se sabe qué va a dar la cámara: lo que se le pide es una
        // preferencia, no una promesa.
        let mut fuente: Option<NativeVideoSource> = None;
        let mut medidas = (0u32, 0u32);

        while CAMARA.load(std::sync::atomic::Ordering::Relaxed) {
            let Ok(trama) = camara.frame() else { break };
            let Ok(rgb) = trama.decode_image::<RgbFormat>() else { continue };
            let (w, h) = (rgb.width(), rgb.height());
            if w == 0 || h == 0 {
                continue;
            }
            // Si la cámara cambia de resolución a media captura —pasa al
            // reenfocar en algunas— se rehace la fuente en vez de tirar tramas.
            if fuente.is_none() || medidas != (w, h) {
                let f = NativeVideoSource::new(
                    VideoResolution { width: w, height: h },
                    // `false` — una cara. El SFU lo usa para decidir su
                    // estrategia: en una cámara prioriza la fluidez, en una
                    // pantalla el detalle del texto aunque baje la tasa.
                    false,
                );
                if fuente.is_none() {
                    nota(format!("cámara: primera trama {w}x{h}"));
                    let _ = fuente_tx.send(f.clone());
                    let _ = listo_tx.send(Ok((w, h)));
                } else {
                    nota(format!("cámara: cambió a {w}x{h}, se rehace la pista"));
                }
                fuente = Some(f);
                medidas = (w, h);
            }
            // Un buffer por trama: `I420Buffer` no se puede clonar y el frame
            // se lo lleva. Reusarlo exigiría que la conversión y el envío no se
            // solapen, que es sincronización a cambio de una asignación que el
            // asignador resuelve en nada.
            let mut buffer = I420Buffer::new(w, h);
            rgb_a_i420(rgb.as_raw(), w, h, &mut buffer);
            guardarme(crate::video_frames::Fuente::Camara, &buffer, w, h);
            fuente.as_ref().expect("recién creada").capture_frame(&VideoFrame {
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

    // Con plazo: entre abrir el dispositivo y la primera trama hay un momento,
    // y en macOS puede aparecer de por medio el diálogo del permiso.
    match listo_rx.recv_timeout(std::time::Duration::from_secs(20)) {
        Ok(Ok((w, h))) => {
            let fuente = fuente_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .map_err(|_| "la cámara arrancó sin fuente".to_string())?;
            Ok((fuente, w, h))
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("la cámara no entregó ninguna imagen".into()),
    }
}

#[cfg(test)]
mod pruebas {
    use super::{es_util, hay_voz, limpiar, rtt_nominado, Dispositivo, UMBRAL_VOZ};

    fn d(id: &str, name: &str) -> Dispositivo {
        Dispositivo { id: id.into(), name: name.into(), current: false }
    }

    /// Lo que de verdad enumera ALSA en un portátil con PipeWire. Sacado de
    /// `arecord -L` y del desplegable que salió en la v1.6.40: quince entradas
    /// para un micrófono.
    fn lo_que_hay_de_verdad() -> Vec<Dispositivo> {
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
            d("alsa:default", "Default ALSA Output (currently PipeWire Media Server)"),
            d("alsa:usbstream:CARD=NVidia", "HDA NVidia"),
            d("alsa:sysdefault:CARD=sofhdadsp", "sof-hda-dsp,"),
            d("alsa:usbstream:CARD=sofhdadsp", "sof-hda-dsp,"),
        ]
    }

    // De quince entradas, dos sirven para elegir un micrófono. Las otras trece
    // son plugins de ALSA con nombres que suenan a dispositivo.
    #[test]
    fn el_desplegable_solo_ensenia_lo_que_es_un_microfono() {
        let limpia = limpiar(lo_que_hay_de_verdad());
        let nombres: Vec<&str> = limpia.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(
            nombres,
            vec!["Default ALSA Output (currently PipeWire Media Server)", "sof-hda-dsp,"],
            "quedaron {} entradas", limpia.len()
        );
    }

    // El mismo códec sale como varios subdispositivos con la misma
    // descripción. Ocho «sof-hda-dsp,» seguidos no son ocho micrófonos.
    #[test]
    fn el_mismo_nombre_no_sale_dos_veces() {
        let limpia = limpiar(vec![
            d("alsa:hw:1,0", "sof-hda-dsp,"),
            d("alsa:hw:1,6", "sof-hda-dsp,"),
            d("alsa:hw:1,7", "sof-hda-dsp,"),
        ]);
        assert_eq!(limpia.len(), 1);
    }

    // Un permitido puede dejar fuera algo válido que no vimos venir. Que la
    // lista se quede vacía es peor que enseñarla sucia: sin entradas, quien
    // tiene el micrófono equivocado no tiene ni cómo intentarlo.
    #[test]
    fn nunca_filtra_hasta_dejarlo_vacio() {
        let raros = vec![d("alsa:algo-que-no-conocemos", "Un micro de otro planeta")];
        assert_eq!(limpiar(raros).len(), 1);
    }

    // Windows y macOS enumeran limpio; el filtro es un apaño para ALSA y no
    // tiene por qué opinar sobre los demás.
    #[test]
    fn fuera_de_alsa_no_se_toca_nada() {
        assert!(es_util("coreaudio:BuiltInMicrophoneDevice"));
        assert!(es_util("wasapi:{0.0.1.00000000}.{abc}"));
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
    fn los_comandos_que_tocan_el_sdk_son_async() {
        const PUEDEN_SER_SINCRONOS: &[&str] = &[
            // Escribe un booleano atómico y nada más.
            "voice_set_deaf",
        ];

        let fuente = include_str!("voice.rs");
        let mut sincronos = Vec::new();
        let mut marcado = false;
        for linea in fuente.lines() {
            let l = linea.trim();
            if l == "#[tauri::command]" {
                marcado = true;
                continue;
            }
            if !marcado || l.is_empty() || l.starts_with("///") || l.starts_with("//") {
                continue;
            }
            marcado = false;
            if let Some(resto) = l.strip_prefix("pub fn ") {
                let nombre = resto.split('(').next().unwrap_or(resto);
                if !PUEDEN_SER_SINCRONOS.contains(&nombre) {
                    sincronos.push(nombre.to_string());
                }
            }
        }
        assert!(
            sincronos.is_empty(),
            "estos comandos son síncronos y no están en la lista de excepciones: {sincronos:?}.\n\
             Un comando síncrono corre en el hilo principal; si toca el SDK de LiveKit, \
             cierra la app. Hazlo `async` o justifícalo en PUEDEN_SER_SINCRONOS."
        );
    }

    fn tono(amplitud: f32) -> Vec<i16> {
        (0..480)
            .map(|i| {
                let t = i as f32 / 48_000.0;
                ((t * 440.0 * std::f32::consts::TAU).sin() * amplitud * i16::MAX as f32) as i16
            })
            .collect()
    }

    // Silencio absoluto es lo que produce `SILENCIADO` poniendo las muestras a
    // cero, así que silenciarse tiene que apagar el indicador sin ningún caso
    // especial en ningún sitio.
    #[test]
    fn el_silencio_no_es_hablar() {
        assert!(!hay_voz(&vec![0i16; 480]));
        assert!(!hay_voz(&[]));
    }

    // El ruido de fondo de una habitación queda muy por debajo del umbral. Si
    // esto empezara a dar `true`, el punto verde estaría encendido siempre y
    // dejaría de significar nada.
    #[test]
    fn el_ruido_de_fondo_no_es_hablar() {
        assert!(!hay_voz(&tono(UMBRAL_VOZ / 4.0)));
    }

    #[test]
    fn una_voz_normal_si_lo_es() {
        assert!(hay_voz(&tono(0.2)));
    }

    // Lo que RMS compra frente al pico: un roce satura una muestra y deja el
    // resto en silencio. Con el pico eso sería «hablando»; con la energía, no.
    #[test]
    fn un_roce_flojo_no_es_hablar() {
        let mut roce = vec![0i16; 480];
        roce[100] = i16::MAX / 8;
        roce[101] = i16::MIN / 8;
        assert!(!hay_voz(&roce));
    }

    // Y lo que **no** compra, escrito para que nadie lo descubra creyendo que
    // es un fallo: un golpe fuerte en diez milisegundos lleva tanta energía
    // como voz. Un teclazo cerca del micro enciende el punto un instante.
    // Distinguirlo pide un detector de voz de verdad, que mira varias tramas.
    #[test]
    fn un_golpe_fuerte_si_lo_enciende_y_se_acepta() {
        let mut golpe = vec![0i16; 480];
        golpe[100] = i16::MAX;
        golpe[101] = i16::MIN;
        assert!(hay_voz(&golpe));
    }
    use livekit::webrtc::stats::{dictionaries, CandidatePairStats, RtcStats};

    fn par(nominado: bool, rtt: f64) -> RtcStats {
        RtcStats::CandidatePair(CandidatePairStats {
            rtc: dictionaries::RtcStats::default(),
            candidate_pair: dictionaries::CandidatePairStats {
                nominated: nominado,
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
    fn coge_el_par_nominado_y_no_el_primero() {
        let stats = vec![par(false, 0.500), par(true, 0.038), par(false, 0.900)];
        assert_eq!(rtt_nominado(&stats), Some(0.038));
    }

    // Un par nominado recién elegido puede no haber completado todavía un
    // consent check. Su cero no es «cero milisegundos», es «no lo sé», y
    // enseñarlo en la cabecera se lee como una conexión perfecta justo cuando
    // aún se está estableciendo.
    #[test]
    fn un_cero_no_es_una_medida() {
        assert_eq!(rtt_nominado(&[par(true, 0.0)]), None);
    }

    #[test]
    fn sin_par_nominado_no_inventa_nada() {
        assert_eq!(rtt_nominado(&[par(false, 0.120)]), None);
    }
}
