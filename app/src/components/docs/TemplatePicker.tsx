import { useState } from "react";
import { Boxes, FileText, Plug, Server, Users } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT, type MessageKey } from "@/lib/i18n";
import { useTasksStore } from "@/store/tasks.store";

/**
 * Por dónde se empieza un documento.
 *
 * Un cuadro de texto vacío no es un punto de partida: es una pregunta sin
 * enunciado, y por eso la mayoría de las listas de este tablero llevan meses sin
 * documentación. Las cuatro plantillas no son maquetas — son las cuatro
 * preguntas que se le hacen a alguien nuevo, ya escritas.
 *
 * Sólo rellenan **Resumen**. Crear un runbook vacío con sus epígrafes puestos no
 * es un runbook: es un documento que dice tener uno cuando no lo tiene, y eso es
 * peor que la pestaña en gris que dice la verdad.
 */

const PLANTILLAS = [
  { key: "project", icon: Boxes },
  { key: "service", icon: Server },
  { key: "client", icon: Users },
  { key: "integration", icon: Plug },
] as const;

export default function TemplatePicker({ onWritten }: { onWritten: () => void }) {
  const { t } = useT();
  const saveDoc = useTasksStore((s) => s.saveDoc);
  const [ocupado, setOcupado] = useState(false);

  const usar = async (cuerpo: string) => {
    setOcupado(true);
    try {
      await saveDoc(cuerpo, "overview");
      onWritten();
    } catch (e) {
      toast.error(t("work:docs.errSave"), { description: String(e) });
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl py-10">
      <div className="mb-6 text-center">
        <FileText className="mx-auto mb-2 size-6 text-muted-foreground" />
        <h2 className="text-sm font-medium">{t("work:docTemplates.title")}</h2>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          {t("work:docTemplates.why")}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {PLANTILLAS.map(({ key, icon: Icon }) => (
          <button
            key={key}
            disabled={ocupado}
            onClick={() => void usar(t(`work:docTemplates.${key}.body` as MessageKey))}
            className="rounded-md border p-3 text-left hover:bg-accent disabled:opacity-60"
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Icon className="size-4 text-muted-foreground" />
              {t(`work:docTemplates.${key}.name` as MessageKey)}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {t(`work:docTemplates.${key}.hint` as MessageKey)}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-4 text-center">
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={onWritten}>
          {t("work:docTemplates.blank")}
        </Button>
      </div>
    </div>
  );
}
