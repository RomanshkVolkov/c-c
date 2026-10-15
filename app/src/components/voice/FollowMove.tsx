import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { useT } from "@/lib/i18n";
import { useVoice } from "@/store/voice.store";

/**
 * La llamada del canal se mudó a una reunión con gente de fuera, y tú con
 * ella: te lleva a su pantalla y dice por qué has cambiado de sala.
 *
 * El cambio de sala lo hace la store (`seguirMudanza`, o `entrar` cuando
 * llegas tarde); esto sólo pone la pantalla, porque la store no tiene router.
 * Sin el aviso, verte de pronto en otra llamada parecería un fallo.
 *
 * Monta una vez, en el layout, como `IncomingCall`: la mudanza llega estés
 * mirando lo que estés mirando.
 */
export default function FollowMove() {
  const mudanza = useVoice((s) => s.mudanza);
  const limpiar = useVoice((s) => s.limpiarMudanza);
  const navigate = useNavigate();
  const { t } = useT();

  useEffect(() => {
    if (!mudanza) return;
    navigate(`/call/${mudanza.inviteId}`);
    toast.info(t("calls:followedMove", { title: mudanza.title }));
    limpiar();
  }, [mudanza, navigate, limpiar, t]);

  return null;
}
