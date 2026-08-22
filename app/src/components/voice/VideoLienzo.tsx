import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@/lib/media";
import { cn } from "@/lib/utils";

/**
 * El vídeo de otra persona, pintado en un lienzo.
 *
 * **No es un `<video>` ni un `<img>` que cambia de `src`.** El motor está en
 * Rust y la interfaz en un webview, así que las tramas tienen que cruzar esa
 * frontera; lo que hay al otro lado es un esquema propio, `cacvideo://`, que
 * devuelve la última trama de esa persona comprimida en JPEG. Ver
 * `docs/voz-video.md`.
 *
 * **Pide al ritmo al que puede pintar, y con un techo.** Cada vuelta empieza
 * cuando la anterior terminó de dibujarse, así que una máquina justa pide menos
 * en vez de acumular cola. Pero además hay un tope: sin él, el bucle pedía todo
 * lo rápido que la máquina daba —cientos de veces por segundo— y cada petición
 * costaba una compresión al otro lado. Eso, con el manejador que entonces era
 * síncrono, colgó la app en la v1.6.38.
 *
 * Y se manda **la trama que ya se tiene** en `?seq=`. Si no ha llegado ninguna
 * nueva, el otro lado contesta 204 y no comprime nada: pedir más deprisa de lo
 * que la cámara produce deja de costar CPU.
 *
 * El lienzo se queda **transparente hasta la primera trama** para que el avatar
 * de debajo siga viéndose. Entre suscribirse a una cámara y recibir su primera
 * imagen pasa medio segundo, y un rectángulo negro durante medio segundo se lee
 * como una cámara rota.
 */

/** Tiene que coincidir con `video_frames::SCHEME` del núcleo en Rust. */
const ESQUEMA = "cacvideo";

/**
 * 30 tramas por segundo como techo. Publicamos vídeo a esa tasa, así que pedir
 * más deprisa no puede traer nada nuevo — sólo trabajo.
 */
const PERIODO_MS = 1000 / 30;

/** Cuánto se espera cuando no hay trama todavía, o cuando algo falló. */
const REINTENTO_MS = 200;

const esperar = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
export default function VideoLienzo({
  identity,
  fuente = "camera",
  espejo,
}: {
  identity: string;
  /** Qué de esa persona: su cara o su pantalla. */
  fuente?: "camera" | "screen";
  /**
   * Voltear en horizontal. Sólo para tu propia cara.
   *
   * Es lo que hace cualquier videollamada y lo que espera cualquiera: te ves
   * como en un espejo, así que levantar la mano derecha mueve el lado derecho
   * de la imagen. Sin voltear, te ves como te ven los demás y todo movimiento
   * sale al revés de donde lo esperas.
   *
   * Nunca en una pantalla compartida: ahí el texto saldría del revés.
   */
  espejo?: boolean;
}) {
  const lienzo = useRef<HTMLCanvasElement>(null);
  const [pintando, setPintando] = useState(false);

  useEffect(() => {
    let vivo = true;
    let seq = 0;
    // El mismo ayudante que los adjuntos: construye la URL correcta para cada
    // sistema y, fuera de Tauri, devuelve la ruta sin más en vez de explotar.
    // `<identidad>/<fuente>`: la cara y la pantalla de la misma persona son dos
    // cosas distintas y se piden por separado.
    const base = convertFileSrc(`${identity}/${fuente}`, ESQUEMA);
    let primera = true;

    const vuelta = async () => {
      while (vivo) {
        const empezo = performance.now();
        try {
          // `seq` es a la vez la cola que evita la caché del webview y lo que
          // le dice al otro lado qué trama tenemos ya.
          const res = await fetch(`${base}?seq=${seq}`);
          if (!vivo) return;
          if (res.status === 404) {
            // Todavía no hay trama de esta persona. No es un error: es que
            // acaba de encender la cámara.
            await esperar(REINTENTO_MS);
            continue;
          }
          if (res.status === 204) {
            // La misma que ya tenemos. La cámara va más despacio que nosotros.
            await esperar(PERIODO_MS);
            continue;
          }
          if (!res.ok) throw new Error(String(res.status));
          seq = Number(res.headers.get("X-Cac-Seq") ?? seq) || seq;

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
          await esperar(REINTENTO_MS);
          continue;
        }
        // El techo: si la vuelta fue más rápida que un fotograma, se espera lo
        // que falta. Es lo que impide que una máquina rápida se dedique a pedir
        // la misma imagen mil veces por segundo.
        await esperar(PERIODO_MS - (performance.now() - empezo));
      }
    };
    void vuelta();
    return () => {
      vivo = false;
    };
  }, [identity, fuente]);

  return (
    <canvas
      ref={lienzo}
      aria-hidden
      className={cn(
        "absolute inset-0 size-full transition-opacity",
        // Una cara se recorta para llenar el mosaico; una pantalla **no**:
        // recortar una pantalla compartida corta justo lo que alguien quería
        // enseñar. Entra entera aunque sobren bandas.
        fuente === "screen" ? "object-contain" : "object-cover",
        espejo && "-scale-x-100",
      )}
      style={{ opacity: pintando ? 1 : 0 }}
    />
  );
}
