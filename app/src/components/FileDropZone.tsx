import { useRef, useState, type ReactNode } from "react";
import { Paperclip } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { acceptFileDrag, carriesFiles, readDropped, takeTransfer } from "@/lib/dropped";

/**
 * Una zona para soltar ficheros, como en WhatsApp Web (jose, 6-oct-2026): al
 * pasar un fichero por encima de una conversación, un recuadro la cubre entera
 * («Suelta para adjuntar»), y se suelta en cualquier parte, no sólo sobre el
 * recuadro de escribir. Lo soltado se entrega a `onFiles`, que lo sube al
 * compositor.
 *
 * El recuadro tapa también el compositor, así que un fichero nunca cae en los
 * dos sitios. Lo que no es un fichero (un texto que se arrastra) pasa de largo.
 */
export default function FileDropZone({
  onFiles,
  children,
  className,
}: {
  onFiles: (files: File[]) => void;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useT();
  const [over, setOver] = useState(false);
  // dragenter y dragleave saltan en cada hijo que se cruza: se cuentan, y el
  // recuadro se va cuando se sale del todo.
  const depth = useRef(0);

  const reset = () => {
    depth.current = 0;
    setOver(false);
  };

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(e) => {
        if (!carriesFiles(e.dataTransfer)) return;
        acceptFileDrag(e.nativeEvent);
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (over) acceptFileDrag(e.nativeEvent);
      }}
      onDragLeave={() => {
        if (!over) return;
        depth.current -= 1;
        if (depth.current <= 0) reset();
      }}
      // En la fase de captura, y sin dejarlo seguir: el recuadro no recibe
      // eventos (pointer-events-none), así que el drop iría al editor de debajo,
      // que lo subiría también. Un fichero, una subida.
      onDropCapture={(e) => {
        if (!over) return;
        e.preventDefault();
        e.stopPropagation();
        reset();
        // Ahora, en el evento: después el DataTransfer ya no deja leer.
        const { files, uris } = takeTransfer(e.dataTransfer);
        void (async () => {
          const read = await readDropped(uris);
          const all = [...files, ...read];
          if (all.length === 0) {
            toast.error(t("common:editor.cannotAttachThat"));
            return;
          }
          onFiles(all);
        })();
      }}
    >
      {children}
      {over && (
        <div
          data-drop-zone
          className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/85 text-sm font-medium text-primary backdrop-blur-sm"
        >
          <Paperclip className="size-6" />
          {t("common:editor.dropToAttach")}
        </div>
      )}
    </div>
  );
}
