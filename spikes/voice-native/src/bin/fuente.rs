// ¿Se puede crear una `NativeVideoSource` desde un hilo suelto?
//
// La app la crea dentro del bucle de captura, que es un `std::thread::spawn`.
// El diario dice que ahí se queda «descodificando» y no vuelve nunca.
use livekit::webrtc::video_source::{native::NativeVideoSource, VideoResolution};

fn crear(donde: &str) {
    let r = std::thread::spawn(|| {
        NativeVideoSource::new(VideoResolution { width: 1280, height: 720 }, false)
    })
    .join();
    println!("{donde}: {}", if r.is_ok() { "creada" } else { "EL HILO MURIÓ" });
}

fn main() {
    crear("hilo suelto, sin runtime");

    let rt = tokio::runtime::Runtime::new().unwrap();
    let _g = rt.enter();
    crear("hilo suelto, con el runtime entrado en main (no en el hilo)");

    let h = rt.handle().clone();
    let r = std::thread::spawn(move || {
        let _g = h.enter();
        NativeVideoSource::new(VideoResolution { width: 1280, height: 720 }, false)
    })
    .join();
    println!("hilo suelto que entra al runtime: {}", if r.is_ok() { "creada" } else { "EL HILO MURIÓ" });
}
