import { useEffect, useRef, useState } from "react";

import VideoLienzo from "@/components/voice/VideoLienzo";
import { isWebBuild } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { browserEngine } from "@/lib/voice-engine/browser";

/**
 * La cara o la pantalla de alguien, con el motor que haya.
 *
 * En el escritorio las tramas cruzan desde Rust y se pintan en un lienzo
 * (`VideoLienzo`). En el build web la pista **ya está en la página**, así que
 * va a un `<video>` sin más: el lienzo pediría a un `cacvideo://` que en un
 * navegador no existe.
 *
 * Mismas reglas que el lienzo: transparente hasta la primera imagen, para que
 * el avatar de debajo se siga viendo; recortada si es una cara, entera si es
 * una pantalla; en espejo sólo la tuya.
 */
export default function VideoSurface(props: {
  identity: string;
  fuente?: "camera" | "screen";
  espejo?: boolean;
}) {
  if (!isWebBuild) return <VideoLienzo {...props} />;
  return <VideoEnPagina {...props} />;
}

function VideoEnPagina({
  identity,
  fuente = "camera",
  espejo,
}: {
  identity: string;
  fuente?: "camera" | "screen";
  espejo?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [pintando, setPintando] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let soltar: (() => void) | null = null;
    // La pista puede llegar después que la orden de pintarla: entre «tiene la
    // cámara encendida» y estar suscrito pasa un instante. Se reintenta cada
    // vez que el motor avisa de que cambiaron las pistas.
    const enganchar = () => {
      soltar?.();
      soltar = browserEngine.attachVideo(identity, fuente, el);
    };
    enganchar();
    const baja = browserEngine.onTracksChanged(enganchar);
    const pinta = () => setPintando(true);
    el.addEventListener("loadeddata", pinta);
    return () => {
      baja();
      soltar?.();
      el.removeEventListener("loadeddata", pinta);
      setPintando(false);
    };
  }, [identity, fuente]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      // El sonido va por su propio elemento (ver el motor): aquí sólo imagen,
      // o la pantalla compartida con audio sonaría dos veces.
      muted
      aria-hidden
      className={cn(
        "absolute inset-0 size-full transition-opacity",
        fuente === "screen" ? "object-contain" : "object-cover",
        espejo && "-scale-x-100",
      )}
      style={{ opacity: pintando ? 1 : 0 }}
    />
  );
}
