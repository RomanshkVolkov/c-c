import { Pin } from "lucide-react";

import { useTasksStore } from "@/store/tasks.store";
import { docKey } from "@/types/task";

/**
 * Lo que hay que saber antes de coger una tarjeta.
 *
 * Sobre el tablero y no dentro del documento porque ahí no lo lee nadie: quien
 * va a coger una tarjeta está mirando el tablero, y un aviso que exige abrir
 * otra pantalla para verlo es un aviso que llega tarde.
 *
 * Sale del índice de documentación, que el navegador ya carga para toda la
 * organización. Pedir el documento entero para leer una línea sería una
 * petición más cada vez que se abre una lista.
 */
export default function PinnedLine({ listId }: { listId: string }) {
  const marca = useTasksStore((s) => s.docIndex[docKey("list", listId)]);
  const linea = marca?.pinnedLine;
  if (!linea) return null;
  return (
    <div className="flex shrink-0 items-start gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
      <Pin className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">{linea}</span>
    </div>
  );
}
