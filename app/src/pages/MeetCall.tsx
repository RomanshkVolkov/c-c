import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2, PhoneCall } from "lucide-react";

import VoiceStage from "@/components/voice/VoiceStage";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useVoice } from "@/store/voice.store";

/**
 * Una reunión con invitados, vista por un miembro (W3).
 *
 * Tiene página propia y no vive dentro de un canal porque **no es la sala de
 * ningún canal**: aunque cuelgue de uno, su sala es `meet:<id>`. El escenario
 * de un canal se pinta dentro del canal; éste, aquí.
 *
 * Entrar es abrir esta página: se llega desde el botón «Entrar» de la lista de
 * reuniones, o desde la barra lateral para volver a la que está en curso.
 */
export default function MeetCall() {
  const { t } = useT();
  const { inviteId } = useParams<{ inviteId: string }>();
  const navigate = useNavigate();
  const meetId = useVoice((s) => s.meetId);
  const meetSpaceId = useVoice((s) => s.meetSpaceId);
  const estado = useVoice((s) => s.estado);
  const escenario = useVoice((s) => s.escenario);
  const error = useVoice((s) => s.error);
  const entrarEnReunion = useVoice((s) => s.entrarEnReunion);
  const abrirEscenario = useVoice((s) => s.abrirEscenario);
  const dentro = meetId === inviteId && estado !== "fuera";

  // Se entra una vez al abrir la página. Volver a ella con la reunión en curso
  // sólo abre la pantalla: reconectar cortaría la conversación.
  const entro = useRef(false);
  useEffect(() => {
    if (!inviteId || entro.current) return;
    entro.current = true;
    if (dentro) abrirEscenario();
    else void entrarEnReunion(inviteId);
  }, [inviteId, dentro, abrirEscenario, entrarEnReunion]);

  // Minimizar es volver a cac con la llamada abierta: al canal del que cuelga,
  // o al resumen si no cuelga de ninguno.
  useEffect(() => {
    if (dentro && !escenario && estado === "dentro") {
      navigate(meetSpaceId ? `/chat?space=${meetSpaceId}` : "/overview");
    }
  }, [dentro, escenario, estado, meetSpaceId, navigate]);

  if (dentro) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <VoiceStage />
      </div>
    );
  }

  if (estado === "fuera" && entro.current) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        {error && (
          <p role="alert" className="max-w-sm text-sm text-destructive">
            {error}
          </p>
        )}
        <Button onClick={() => inviteId && void entrarEnReunion(inviteId)}>
          <PhoneCall className="size-4" /> {t("calls:join")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> {t("calls:opening")}
    </div>
  );
}
