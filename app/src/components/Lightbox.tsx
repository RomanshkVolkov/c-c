import { useExitThen } from "@/lib/use-presence";
import { originRef } from "@/lib/motion-origin";
import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Una imagen a pantalla completa, hasta que se pulse fuera o Escape.
 *
 * Vivía dentro de `Markdown.tsx`, que es donde se necesitó primero: una captura
 * pegada en un comentario. Sale aquí porque la galería de una tarjeta necesita
 * exactamente lo mismo — y una captura adjunta a un reporte de cliente es la que
 * más falta hace ver entera, que es justo la que no se podía.
 *
 * El `stopPropagation` del Escape es lo que impide que la misma tecla cierre
 * también el cajón de debajo y te deje sin las dos cosas de un golpe.
 */
export default function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  // La salida, y al acabar se cierra de verdad.
  const exit = useExitThen(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      exit.leave();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [exit]);

  return createPortal(
    <div
      role="presentation"
      // Sale encogiéndose antes de cerrarse (`useExitThen`).
      onClick={exit.leave}
      data-closing={exit.leaving || undefined}
      // Crece desde la miniatura que se pulsó (ver `motion-origin.ts`).
      ref={originRef("viewport")}
      className="motion-open fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-6"
    >
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
      />
    </div>,
    document.body,
  );
}
