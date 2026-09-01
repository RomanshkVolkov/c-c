import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { enviarAudio, recogerAudio, type Borrador } from "@/lib/voice-report";

/**
 * Lo que se va a mandar, antes de mandarlo.
 *
 * La primera versión de esto no existía: el botón fichaba en el acto. Era
 * agresivo por dos razones que no se ven hasta que lo pulsas — **crea una
 * tarjeta en un tablero compartido**, y **manda el nombre de tu micrófono y el
 * diario de tu máquina**. Las dos cosas se preguntan, y lo segundo se enseña.
 *
 * Lo que **no** hace es pedirte que rellenes nada para poder mandar. La nota es
 * opcional y está debajo; el botón de mandar funciona sin tocarla. Esa parte del
 * razonamiento original seguía siendo buena: quien abre esto está en mitad de
 * una reunión.
 *
 * Y hay un beneficio que no se buscaba: el veredicto se calcula al abrir, así
 * que quien lee «estabas silenciado» lo arregla y cierra sin fichar nada.
 */
export default function VoiceReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useT();
  const [borrador, setBorrador] = useState<Borrador | null>(null);
  const [nota, setNota] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [verTodo, setVerTodo] = useState(false);

  // Se pregunta al motor al abrir, no al pulsar mandar: el veredicto es la mitad
  // del valor de esta pantalla y tiene que estar antes de decidir nada.
  useEffect(() => {
    if (!open) return;
    setBorrador(null);
    setVerTodo(false);
    void recogerAudio(nota).then(setBorrador);
    // `nota` fuera a propósito: recalcular con cada tecla pediría el estado del
    // motor en cada pulsación, y la nota se vuelve a meter al mandar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mandar = async () => {
    if (!borrador) return;
    setEnviando(true);
    try {
      // Se vuelve a recoger con la nota puesta. Es una llamada más y evita
      // tener que reconstruir el markdown aquí, que sería un segundo sitio
      // donde el formato de la tarjeta podría divergir.
      const conNota = nota.trim() ? await recogerAudio(nota) : borrador;
      const salida = await enviarAudio(conNota);
      if (salida === "done") toast.success(t("common:voice.reportFiled"));
      else if (salida === "failed") {
        toast.error(t("common:voice.reportFailed"), {
          description: t("common:voice.reportFailedBody"),
        });
      }
      onOpenChange(false);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("common:voice.reportTitle")}</DialogTitle>
          <DialogDescription>{t("common:voice.reportPrivacy")}</DialogDescription>
        </DialogHeader>

        {!borrador ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t("common:voice.reportChecking")}
          </p>
        ) : (
          <div className="space-y-3">
            <section className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("common:voice.reportWhatWeSee")}
              </p>
              {/* El veredicto en crudo y sin markdown: lleva asteriscos porque
                  en la tarjeta va en negrita, y aquí importa que se lea, no que
                  se pinte bonito. */}
              <p className="rounded-md border bg-muted/40 p-2.5 text-sm">
                {borrador.veredicto.replace(/\*\*/g, "")}
              </p>
            </section>

            <section className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="nota-audio">
                {t("common:voice.reportNote")}
              </label>
              <Input
                id="nota-audio"
                value={nota}
                onChange={(e) => setNota(e.target.value)}
                placeholder={t("common:voice.reportNotePlaceholder")}
              />
            </section>

            <button
              type="button"
              className="text-xs text-muted-foreground underline hover:text-foreground"
              onClick={() => setVerTodo((v) => !v)}
            >
              {t("common:voice.reportWhatIsSent")}
            </button>
            {verTodo && (
              <pre className="max-h-56 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                {borrador.cuerpo}
              </pre>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t("common:voice.reportCancel")}
              </Button>
              <Button size="sm" onClick={() => void mandar()} disabled={enviando}>
                {enviando && <Loader2 className="mr-1 size-3 animate-spin" />}
                {t("common:voice.reportSend")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
