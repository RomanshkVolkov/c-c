//! Spike 0b: ¿sirve el SDK Rust de LiveKit como motor de voz de cac?
//!
//! Hace falta porque el webview de Linux **no puede**: el WebKitGTK de Arch
//! viene compilado sin WebRTC, así que `livekit-client` en el webview quedó
//! descartado por medición, no por gusto. El plan pasó a un motor nativo, y
//! antes de meterle libwebrtc al build de todo el mundo esto contesta tres
//! preguntas con hechos:
//!
//!   1. ¿Conecta y publica audio contra un LiveKit real?
//!   2. ¿Se puede verificar sin oídos, para que la máquina lo compruebe?
//!   3. ¿A qué precio? (compilación, peso, y si hay cancelación de eco)
//!
//! Publica un tono en vez de un micrófono a propósito: sin hardware de por
//! medio, un fallo aquí es del SDK o de la red, nunca del audio del sistema.
//! El micro real es el paso siguiente, y ése sí lo tiene que oír una persona.
//!
//! Uso:
//!   docker run --rm -p7880:7880 -p7882:7882/udp livekit/livekit-server --dev
//!   cargo run

use std::time::Duration;

use livekit::options::TrackPublishOptions;
use livekit::track::{LocalAudioTrack, LocalTrack, TrackSource};
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::prelude::AudioFrame;
use livekit::{Room, RoomOptions};
use livekit_api::access_token::{AccessToken, VideoGrants};
use livekit_api::services::room::RoomClient;

/// Por defecto, el modo `--dev` de livekit-server: sus llaves no son un secreto
/// —las imprime en su propio arranque— y sólo escucha en localhost.
///
/// Se pueden apuntar a un servidor de verdad por entorno (`LK_URL`, `LK_KEY`,
/// `LK_SECRET`), que es como se comprueba si el media atraviesa la red real.
/// Por entorno y no por argumentos para que el secreto no quede en la lista de
/// procesos ni en el historial del shell.
fn env_o(clave: &str, por_defecto: &str) -> String {
    std::env::var(clave).unwrap_or_else(|_| por_defecto.to_string())
}
const SALA: &str = "spike-nativo";

/// 48 kHz mono: lo que WebRTC usa internamente, así que no hay remuestreo que
/// pueda enmascarar un problema.
const SAMPLE_RATE: u32 = 48_000;
const CANALES: u32 = 1;
/// 10 ms por trama — el tamaño que espera libwebrtc.
const MUESTRAS_POR_TRAMA: usize = (SAMPLE_RATE as usize) / 100;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let identidad = "spike-emisor";

    let ws_url = env_o("LK_URL", "ws://localhost:7880");
    let http_url = ws_url.replacen("ws", "http", 1);
    let api_key = env_o("LK_KEY", "devkey");
    let api_secret = env_o("LK_SECRET", "secret");

    let token = AccessToken::with_api_key(&api_key, &api_secret)
        .with_identity(identidad)
        .with_name("Spike emisor")
        .with_grants(VideoGrants { room_join: true, room: SALA.to_string(), ..Default::default() })
        .to_jwt()?;

    println!("→ conectando a {ws_url} (sala «{SALA}»)…");
    let (room, mut eventos) = Room::connect(&ws_url, &token, RoomOptions::default()).await?;
    println!("✓ conectado como «{}»", room.local_participant().identity());

    // La pregunta cara del plan, contestada por el tipo: el SDK **sí** expone
    // la cancelación de eco (y supresión de ruido y control de ganancia). Sin
    // esto, v1 habría tenido que pedir auriculares por escrito.
    let opciones = AudioSourceOptions {
        echo_cancellation: true,
        noise_suppression: true,
        auto_gain_control: true,
    };
    println!("✓ AudioSourceOptions expone AEC/NS/AGC: {opciones:?}");

    let fuente = NativeAudioSource::new(opciones, SAMPLE_RATE, CANALES, 1_000);
    let pista = LocalAudioTrack::create_audio_track(
        "tono-de-prueba",
        RtcAudioSource::Native(fuente.clone()),
    );

    room.local_participant()
        .publish_track(
            LocalTrack::Audio(pista),
            TrackPublishOptions { source: TrackSource::Microphone, ..Default::default() },
        )
        .await?;
    println!("✓ pista de audio publicada");

    // Un la de 440 Hz, en tramas de 10 ms, hasta que se acabe el tiempo.
    tokio::spawn(async move {
        let mut fase = 0f32;
        let paso = 2.0 * std::f32::consts::PI * 440.0 / SAMPLE_RATE as f32;
        loop {
            let datos: Vec<i16> = (0..MUESTRAS_POR_TRAMA)
                .map(|_| {
                    fase = (fase + paso) % (2.0 * std::f32::consts::PI);
                    (fase.sin() * 8_000.0) as i16
                })
                .collect();
            let trama = AudioFrame {
                data: datos.into(),
                sample_rate: SAMPLE_RATE,
                num_channels: CANALES,
                samples_per_channel: MUESTRAS_POR_TRAMA as u32,
            };
            if fuente.capture_frame(&trama).await.is_err() {
                break;
            }
        }
    });

    // Que el servidor lo confirme, que es la prueba que no depende de oídos.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let cliente = RoomClient::with_api_key(&http_url, &api_key, &api_secret);
    let dentro = cliente.list_participants(SALA).await?;
    println!("\n── lo que ve el servidor ──");
    for p in &dentro {
        println!(
            "  participante «{}» con {} pista(s): {}",
            p.identity,
            p.tracks.len(),
            p.tracks.iter().map(|t| format!("{} ({:?})", t.name, t.r#type())).collect::<Vec<_>>().join(", "),
        );
    }

    let publicando = dentro
        .iter()
        .find(|p| p.identity == identidad)
        .map(|p| !p.tracks.is_empty())
        .unwrap_or(false);
    println!(
        "\n{}",
        if publicando {
            "✓ VEREDICTO: el SDK nativo conecta y publica audio verificado por el servidor."
        } else {
            "✗ VEREDICTO: conectó pero el servidor no ve la pista."
        }
    );

    // Un rato más vivo por si alguien quiere oír el tono desde meet.livekit.io.
    println!("\n(20 s emitiendo el tono; Ctrl-C para cortar)");
    let fin = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < fin {
        tokio::select! {
            Some(ev) = eventos.recv() => {
                // Sin volcar el evento crudo: `TokenRefreshed` lleva un JWT
                // vivo, y un secreto que acaba en la terminal acaba en el
                // scrollback, en una captura y en un pegado. Se imprime la
                // forma del evento, que es lo que aquí sirve para algo.
                let etiqueta = format!("{ev:?}");
                let corte = etiqueta.find(|c| c == '{' || c == '(').unwrap_or(etiqueta.len());
                println!("  evento: {}", &etiqueta[..corte].trim());
            }
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
        }
    }
    Ok(())
}
