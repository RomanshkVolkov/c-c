import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";

/**
 * Lo que se va a grabar, antes de grabarlo.
 *
 * **Siempre pregunta**, aunque sea el segundo botón que se pulsa en la misma
 * llamada. Es el mismo razonamiento que el de reportar audio: lo que hace no se
 * ve hasta que ya pasó —queda un fichero con la voz de otras personas, en un
 * servidor, y lo puede ver todo el canal— y eso no se dispara por un clic de
 * más al buscar el botón de silenciar, que está al lado.
 *
 * Y dice **las tres cosas que alguien querría saber** antes de decir que sí: qué
 * entra, qué no entra —las cámaras no— y quién lo va a poder ver. La frase de
 * las cámaras no es decorativa: es la decisión de producto, y hay una prueba que
 * exige que esté.
 */
export default function RecordingConsentDialog({
  open,
  onOpenChange,
  onConfirm,
  inFlight,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
  inFlight?: boolean;
}) {
  const { t } = useT();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("recordings:consentTitle")}</DialogTitle>
          <DialogDescription>{t("recordings:consentBody")}</DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li>{t("recordings:consentWhere")}</li>
          {/* Que los demás lo van a ver. Quien graba tiene que saber que no es
              una operación silenciosa — y quien no lo sepa, al leerlo, decide
              distinto. */}
          <li>{t("recordings:consentEveryone")}</li>
        </ul>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={inFlight}>
            {t("recordings:cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={inFlight}>
            {inFlight && <Loader2 className="mr-2 size-4 animate-spin" />}
            {t("recordings:consentConfirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
