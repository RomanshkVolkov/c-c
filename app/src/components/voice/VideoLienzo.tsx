import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@/lib/media";

/**
 * El vídeo de otra persona, pintado en un lienzo.
 *
 * **No es un `<video>` ni un `<img>` que cambia de `src`.** El motor está en
 * Rust y la interfaz en un webview, así que las tramas tienen que cruzar esa
 * frontera; lo que hay al otro lado es un esquema propio, `cacvideo://`, que
 * devuelve la última trama de esa persona comprimida en JPEG. Ver
 * `docs/voz-video.md`.
 *
 * **Pide al ritmo al que puede pintar, no al que llegan.** Cada vuelta empieza
 * cuando la anterior terminó de dibujarse, así que si la máquina va justa se
 * piden menos tramas en vez de acumular una cola — y en Rust no se comprime
 * ninguna que nadie vaya a mirar. Un `setInterval` a 30 Hz haría lo contrario:
 * seguiría pidiendo mientras la anterior no ha llegado.
 *
 * El lienzo se queda **transparente hasta la primera trama** para que el avatar
 * de debajo siga viéndose. Entre suscribirse a una cámara y recibir su primera
 * imagen pasa medio segundo, y un rectángulo negro durante medio segundo se lee
 * como una cámara rota.
 */

/** Tiene que coincidir con `video_frames::SCHEME` del núcleo en Rust. */
const ESQUEMA = "cacvideo";
export default function VideoLienzo({ identity }: { identity: string }) {
  const lienzo = useRef<HTMLCanvasElement>(null);
  const [pintando, setPintando] = useState(false);

  useEffect(() => {
    let vivo = true;
    let sig = 0;
    // El mismo ayudante que los adjuntos: construye la URL correcta para cada
    // sistema y, fuera de Tauri, devuelve la ruta sin más en vez de explotar.
    const base = convertFileSrc(identity, ESQUEMA);
    let primera = true;

    const vuelta = async () => {
      while (vivo) {
        try {
          // La cola cambia en cada vuelta: la URL es siempre la misma trama y
          // sin esto el webview serviría la primera para siempre desde su
          // caché, por muchos `no-store` que mande el otro lado.
          const res = await fetch(`${base}?t=${sig++}`);
          if (!vivo) return;
          if (res.status === 404) {
            // Todavía no hay trama de esta persona. No es un error: es que
            // acaba de encender la cámara.
            await new Promise((r) => setTimeout(r, 120));
            continue;
          }
          if (!res.ok) throw new Error(String(res.status));

          const bitmap = await createImageBitmap(await res.blob());
          if (!vivo) {
            bitmap.close();
            return;
          }
          const c = lienzo.current;
          if (c) {
            // El lienzo toma el tamaño de la trama, no del hueco: el CSS lo
            // escala, y así una cámara que cambia de resolución no obliga a
            // repintar el layout.
            if (c.width !== bitmap.width || c.height !== bitmap.height) {
              c.width = bitmap.width;
              c.height = bitmap.height;
            }
            c.getContext("2d")?.drawImage(bitmap, 0, 0);
            if (primera) {
              primera = false;
              setPintando(true);
            }
          }
          bitmap.close();
        } catch {
          // Un fallo suelto no apaga el vídeo: se espera un poco y se vuelve a
          // pedir. Apagarlo dejaría el mosaico en el avatar para siempre por un
          // tropiezo de una trama.
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    };
    void vuelta();
    return () => {
      vivo = false;
    };
  }, [identity]);

  return (
    <canvas
      ref={lienzo}
      aria-hidden
      className="absolute inset-0 size-full object-cover transition-opacity"
      style={{ opacity: pintando ? 1 : 0 }}
    />
  );
}
