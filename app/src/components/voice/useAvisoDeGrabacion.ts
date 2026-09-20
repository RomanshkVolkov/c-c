import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useT } from "@/lib/i18n";
import { useVoice } from "@/store/voice.store";

/**
 * Avisa de que alguien ha empezado a grabar, para quien no está mirando.
 *
 * Quien tiene el escenario abierto ya lo ve: hay una franja que lo dice y un
 * chip en la cabecera. Quien minimizó la llamada y está leyendo el tablero no
 * ve ninguna de las dos cosas — y es justo quien sigue hablando sin saberlo.
 *
 * **Se calla con el escenario abierto** a propósito. El mismo hecho anunciado
 * en una franja y en un toast se lee como dos grabaciones, y la segunda no
 * añade nada que la primera no dijera.
 *
 * Una vez por grabación, por id: parar y volver a empezar es otra, y ésa sí se
 * anuncia. Con un booleano, la segunda pasaría en silencio.
 */
export function useAvisoDeGrabacion(nombre?: string) {
  // `useT` y no `i18next.t` suelto: es lo que suscribe al cambio de idioma sin
  // esperar a que algo más provoque un repintado. La razón está escrita en
  // `lib/i18n.ts`.
  const { t } = useT();
  const grabacion = useVoice((s) => s.grabacion);
  const escenario = useVoice((s) => s.escenario);
  const avisada = useRef<string | null>(null);

  useEffect(() => {
    if (!grabacion) return;
    if (avisada.current === grabacion.id) return;
    avisada.current = grabacion.id;
    // Con el escenario abierto, la franja ya lo ha dicho. Se apunta como
    // avisada igual: si luego minimiza, no tiene sentido soltarle el toast de
    // algo que ya leyó.
    if (escenario) return;
    toast.info(
      nombre
        ? t("recordings:startedToast", { name: nombre })
        : t("recordings:joinedBannerTitle"),
      { description: t("recordings:joinedBannerBody") },
    );
  }, [grabacion, escenario, nombre, t]);
}
