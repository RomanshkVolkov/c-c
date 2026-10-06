import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/push";
import { Button } from "@/components/ui/button";

/**
 * «Avisos en este dispositivo» (W2): suscribir este navegador a la campana.
 *
 * Sólo en la versión web: es lo que hace que el teléfono suene con la app
 * cerrada. El estado se pregunta al navegador cada vez que se abre, porque el
 * permiso se puede quitar desde los ajustes del sistema sin que la app lo sepa.
 */
export default function PushDeviceRow() {
  const { t } = useT();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void pushState().then(setState).catch(() => setState("unsupported"));
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      setState(state === "on" ? await disablePush() : await enablePush());
    } catch (e) {
      toast.error(t("notifications:push.failed"), { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return null;

  const hint =
    state === "unsupported"
      ? t("notifications:push.unsupported")
      : state === "denied"
        ? t("notifications:push.denied")
        : state === "off-server"
          ? t("notifications:push.offServer")
          : state === "on"
            ? t("notifications:push.onHint")
            : t("notifications:push.offHint");

  return (
    <div className="flex items-start gap-3 rounded border px-3 py-2">
      <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">{t("notifications:push.title")}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {(state === "on" || state === "off") && (
        <Button size="sm" variant={state === "on" ? "ghost" : "default"} disabled={busy} onClick={() => void toggle()}>
          {state === "on" ? t("notifications:push.disable") : t("notifications:push.enable")}
        </Button>
      )}
    </div>
  );
}
