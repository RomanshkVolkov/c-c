import { useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { drawPage, openPdf } from "@/lib/pdf";

/**
 * Un PDF adjunto como tarjeta, al estilo de Slack: icono, nombre y la primera
 * página, en vez de un enlace con el nombre (jose, 6-oct-2026). Un clic abre el
 * visor (`PdfPreview`).
 *
 * La página se dibuja **cuando la tarjeta entra en pantalla**, no antes: un
 * canal con veinte PDF no descarga veinte PDF al abrirse. Y si no se puede
 * dibujar (sin red, un PDF roto), la tarjeta se queda con su nombre y sigue
 * abriendo el visor, que dirá por qué.
 */
export const CARD_WIDTH = 360;

export default function PdfCard({
  url,
  fileName,
  onOpen,
  onRemove,
}: {
  url: string;
  fileName: string;
  onOpen: () => void;
  /** En el editor, donde el enlace está escondido detrás de la tarjeta, es la forma de quitarlo. */
  onRemove?: () => void;
}) {
  const { t } = useT();
  const box = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    void (async () => {
      try {
        const loading = await openPdf(url);
        task = loading;
        if (cancelled) return;
        const doc = await loading.promise;
        if (cancelled || !canvas.current) return;
        await drawPage(doc, 1, canvas.current, CARD_WIDTH);
        if (!cancelled) setDrawn(true);
      } catch {
        // Sin miniatura: la tarjeta sigue con su nombre y abre el visor.
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [visible, url]);

  return (
    <span
      ref={box}
      role="button"
      tabIndex={0}
      data-pdf-card={fileName}
      contentEditable={false}
      title={t("common:last.preview")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="my-2 block max-w-full cursor-pointer select-none overflow-hidden rounded-xl border bg-card text-left no-underline transition-colors hover:border-primary/50"
      style={{ width: CARD_WIDTH }}
    >
      <span className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-red-600 text-white">
          <FileText className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{fileName}</span>
          <span className="block text-xs text-muted-foreground">PDF</span>
        </span>
        {onRemove && (
          <span
            role="button"
            tabIndex={0}
            aria-label={t("common:last.removePdf")}
            title={t("common:last.removePdf")}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </span>
        )}
      </span>
      <span className={drawn ? "block max-h-52 overflow-hidden border-t bg-white" : "hidden"}>
        <canvas ref={canvas} className="block" />
      </span>
    </span>
  );
}
