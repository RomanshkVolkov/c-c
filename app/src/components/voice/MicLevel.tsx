import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Si tu micrófono entra, dicho **antes** de llamar a nadie.
 *
 * Hasta ahora la única forma de saberlo era llamar a alguien y preguntarle si
 * se te oía — o sea, averiguarlo después de haberle hecho perder el rato. El
 * botón de reportar de dentro de la llamada cubrió el caso grave, pero llega
 * igual de tarde por definición.
 *
 * Enseña **qué dispositivo se abrió de verdad**, no el que dice el desplegable.
 * Son cosas distintas: el sistema puede entregar otro, y esa diferencia fue
 * media investigación del fallo de «no se me oye».
 */

interface Formato {
  dispositivo: string;
  ritmo: number;
  canales: number;
  formato: string;
  ritmoDeLaFuente: number;
  coincide: boolean;
}

interface Nivel {
  enLlamada: boolean;
  picoMilesimas: number;
  formatoEntrada: Formato | null;
  error: string | null;
}

/** Cada cuánto se pregunta. Es también lo que mantiene viva la prueba. */
const CADA = 120;

export default function MicLevel() {
  const { t } = useT();
  const [nivel, setNivel] = useState<Nivel | null>(null);
  // El máximo reciente, para que la barra no parpadee con cada sílaba: la voz
  // tiene silencios de décimas dentro de una misma palabra, y una barra que los
  // sigue literalmente se lee como un micrófono que se corta.
  const decaido = useRef(0);
  const [pintado, setPintado] = useState(0);

  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      try {
        const n = await invoke<Nivel>("voice_mic_level");
        if (!vivo) return;
        setNivel(n);
        const ahora = n.picoMilesimas / 1000;
        decaido.current = Math.max(ahora, decaido.current * 0.82);
        setPintado(decaido.current);
      } catch {
        // El motor de voz puede no estar montado —un build sin LiveKit— y eso
        // no es motivo para que el panel de dispositivos deje de servir.
        if (vivo) setNivel(null);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), CADA);
    // Al desmontar se deja de preguntar, y la prueba se cierra sola: por eso no
    // hay comando de parar. Ver `PRUEBA_HASTA` en el lado de Rust.
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, []);

  if (!nivel) return null;

  const f = nivel.formatoEntrada;
  // Casi todo el rango útil de la voz vive en la parte baja de la escala, así
  // que una barra lineal casi no se mueve al hablar normal. La raíz reparte el
  // recorrido donde de verdad ocurre.
  const ancho = Math.min(100, Math.round(Math.sqrt(pintado) * 100));

  return (
    <div className="px-3 pb-2 pt-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          role="meter"
          aria-label={t("common:last.micLevel")}
          aria-valuenow={ancho}
          aria-valuemin={0}
          aria-valuemax={100}
          className={cn(
            "h-full rounded-full transition-[width] duration-100",
            ancho > 2 ? "bg-success" : "bg-muted-foreground/30",
          )}
          style={{ width: `${Math.max(ancho, 2)}%` }}
        />
      </div>

      {/* Qué se abrió de verdad. Sin esto la barra dice «entra señal» sin decir
          por dónde, que es la mitad de la respuesta. */}
      {f && (
        <p className="mt-1 truncate text-[11px] text-muted-foreground" title={f.dispositivo}>
          {f.dispositivo} · {f.ritmo} Hz · {f.canales === 1 ? "mono" : `${f.canales} ch`}
        </p>
      )}
      {f && !f.coincide && (
        <p className="mt-0.5 text-[11px] text-amber-500">
          {t("common:last.micRateMismatch", { device: f.ritmo, source: f.ritmoDeLaFuente })}
        </p>
      )}
      {nivel.error && (
        <p className="mt-0.5 text-[11px] text-destructive">{nivel.error}</p>
      )}
      {!nivel.error && !f && (
        <p className="mt-1 text-[11px] text-muted-foreground">{t("common:last.micOpening")}</p>
      )}
    </div>
  );
}
