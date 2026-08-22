import { MicOff } from "lucide-react";
import VideoLienzo from "@/components/voice/VideoLienzo";
import { iniciales } from "@/lib/desde";
import { cn } from "@/lib/utils";

/**
 * Un participante en el escenario.
 *
 * El borde verde es el **único** indicador de que alguien habla. Se probaron
 * ondas y contadores de nivel y sobran: con cuatro mosaicos en pantalla lo que
 * uno busca es cuál de ellos se ha encendido, y para eso el contorno es lo más
 * rápido de leer y lo más barato de repintar treinta veces por segundo.
 *
 * Con cámara, el vídeo llena el mosaico y el avatar se queda debajo hasta que
 * llegue la primera trama — ver `VideoLienzo`. Sin cámara, iniciales.
 */
export default function VoiceTile({
  nombre,
  hablando,
  silenciado,
  compacto,
  video,
  espejo,
}: {
  nombre: string;
  hablando: boolean;
  silenciado?: boolean;
  /** La identidad cuya cámara pintar, o nada si no publica vídeo. */
  video?: string;
  /** Tu propia cara va en espejo. Ver `VideoLienzo`. */
  espejo?: boolean;
  /** En la tira lateral del compartir; en la rejilla, no. */
  compacto?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative grid min-h-0 place-items-center overflow-hidden rounded-xl border-2 bg-card transition-colors",
        hablando ? "border-success" : "border-border",
        compacto && "h-30",
      )}
    >
      <span
        className={cn(
          "grid shrink-0 place-items-center rounded-full bg-accent font-bold text-accent-foreground",
          compacto ? "size-11 text-sm" : "size-21 text-2xl",
        )}
      >
        {iniciales(nombre)}
      </span>

      {video && <VideoLienzo identity={video} espejo={espejo} />}

      <span className="absolute bottom-3 left-3 max-w-[calc(100%-4rem)] truncate rounded-full bg-background/70 px-2.5 py-1 text-[13px]">
        {nombre}
      </span>

      {/* El icono y no la palabra: en un mosaico de 200 px «Muted» tapa el
          nombre, y el micrófono tachado se entiende en cualquier idioma. */}
      {silenciado && (
        <span
          title={`${nombre} is muted`}
          className="absolute bottom-3 right-3 flex rounded-full bg-background/70 p-1.5 text-destructive"
        >
          <MicOff className="size-[15px]" />
        </span>
      )}
    </div>
  );
}
