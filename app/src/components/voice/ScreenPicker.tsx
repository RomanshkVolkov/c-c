import { Monitor } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useVoice } from "@/store/voice.store";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Cuál pantalla compartir, cuando hay más de una (#117).
 *
 * Sólo sale donde elige la app —X11, Windows, macOS con varios monitores—: en
 * Wayland pregunta el diálogo del sistema y esto ni aparece.
 */
export default function ScreenPicker() {
  const { t } = useT();
  const fuentes = useVoice((s) => s.eligiendoPantalla);
  const compartirPantalla = useVoice((s) => s.compartirPantalla);
  const cancelar = useVoice((s) => s.cancelarEleccionPantalla);

  return (
    <Dialog open={!!fuentes} onOpenChange={(v) => !v && cancelar()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("common:voice.pickScreenTitle")}</DialogTitle>
          <DialogDescription>{t("common:voice.pickScreenLead")}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {(fuentes ?? []).map((f, i) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => void compartirPantalla(f.id)}
                className="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <Monitor className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.title || t("common:voice.screenN", { n: i + 1 })}</span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
