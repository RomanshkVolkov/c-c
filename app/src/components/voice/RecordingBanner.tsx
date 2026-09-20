import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useVoice } from "@/store/voice.store";

/**
 * «Esta llamada se está grabando», para quien acaba de entrar.
 *
 * Existe porque el consentimiento de quien graba no es el consentimiento de los
 * demás. Quien pulsa el botón lee un diálogo; quien entra diez minutos después
 * no ha leído nada, y el chip de la esquina es fácil de no mirar cuando lo que
 * haces al entrar es hablar.
 *
 * **No bloquea.** No es un diálogo modal: es una franja con dos salidas —
 * enterado, o salirse—. Un modal en mitad de una reunión en curso interrumpe a
 * la persona equivocada, y el consentimiento acordado es «aviso + quedarse»,
 * no «acepta para poder hablar».
 *
 * Se enseña **una vez por grabación**: si alguien para y vuelve a empezar, es
 * otra grabación y vuelve a avisar. Reaparecer en cada tick del reloj sería una
 * franja que nadie lee.
 */
export default function RecordingBanner() {
  const { t } = useT();
  const grabacion = useVoice((s) => s.grabacion);
  const salir = useVoice((s) => s.salir);
  const [oculto, setOculto] = useState(false);
  // Cuál se ha dado ya por leída. Un id y no un booleano: parar y volver a
  // empezar es otra grabación, y esa sí se avisa.
  const vista = useRef<string | null>(null);

  useEffect(() => {
    if (grabacion && vista.current !== grabacion.id) {
      vista.current = grabacion.id;
      setOculto(false);
    }
  }, [grabacion]);

  if (!grabacion || oculto) return null;

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-destructive/30
                 bg-destructive/10 px-4 py-2 text-sm"
    >
      <span className="font-semibold text-destructive">{t("recordings:joinedBannerTitle")}</span>
      <span className="text-muted-foreground">{t("recordings:joinedBannerBody")}</span>
      <span className="flex-1" />
      {/* Irse es una salida de verdad y está al mismo nivel que enterarse: si
          la única opción fuera «entendido», el aviso sería un trámite. */}
      <Button variant="ghost" size="sm" onClick={() => void salir()}>
        {t("recordings:joinedBannerLeave")}
      </Button>
      <Button size="sm" onClick={() => setOculto(true)}>
        {t("recordings:joinedBannerOk")}
      </Button>
    </div>
  );
}
