import { useState } from "react";
import { FileText } from "lucide-react";
import { toast } from "sonner";

import DecisionForm from "@/components/docs/DecisionForm";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useT, type MessageKey } from "@/lib/i18n";
import { useTasksStore } from "@/store/tasks.store";
import { DOC_TABS, type DocTabKey } from "@/types/task";

/**
 * Guardar un mensaje en la documentación del proyecto.
 *
 * La dirección que faltaba. Se comparte un documento en un canal y se discute
 * ahí, y lo que sale de esa discusión se queda en el canal — donde nadie lo
 * vuelve a encontrar. Esto lo devuelve al sitio donde alguien irá a buscarlo.
 *
 * **Guardar en Decisiones no es lo mismo que guardar en las otras tres.** Esa
 * pestaña no es markdown: es un registro con autor y procedencia, así que ahí un
 * mensaje se convierte en una entrada, no en un párrafo. La procedencia queda
 * apuntando al mensaje, que es de dónde salió de verdad.
 */

const ROTULOS: Record<DocTabKey, MessageKey> = {
  overview: "work:docs.overview",
  runbook: "work:docs.runbook",
  decisions: "work:docs.decisions",
  links: "work:docs.links",
};

export default function MessageToDoc({
  body,
  messageId,
  spaceId,
  spaceName,
}: {
  body: string;
  messageId: string;
  spaceId: string;
  spaceName: string;
}) {
  const { t } = useT();
  const activeListId = useTasksStore((s) => s.activeListId);
  const tree = useTasksStore((s) => s.tree);
  const appendToDoc = useTasksStore((s) => s.appendToDoc);
  const addDecisionTo = useTasksStore((s) => s.addDecisionTo);
  const [decidiendo, setDecidiendo] = useState(false);

  // La misma regla que al hacer una tarjeta desde un mensaje: la lista tiene que
  // ser de este espacio. Documentación de un cliente escrita desde el canal de
  // otro es un error con radio de explosión, así que se impide en vez de avisar.
  const space = tree.find((s) => s.id === spaceId);
  const enEsteEspacio = Boolean(
    space &&
      activeListId &&
      (space.lists.some((l) => l.id === activeListId) ||
        space.folders.some((f) => f.lists.some((l) => l.id === activeListId))),
  );

  const guardar = async (tab: DocTabKey) => {
    if (!activeListId) return;
    if (tab === "decisions") {
      setDecidiendo(true);
      return;
    }
    try {
      // La cita y la atribución van con el texto: un párrafo que aparece en un
      // runbook sin decir de dónde salió es indistinguible de uno que alguien
      // escribió con conocimiento de causa.
      const cita = body
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      await appendToDoc("list", activeListId, tab, `${cita}\n\n— ${t("work:docs.fromChannel", { where: spaceName })}`);
      toast.success(t("work:docs.savedToDoc"));
    } catch (e) {
      toast.error(t("work:docs.errSave"), { description: String(e) });
    }
  };

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          disabled={!enEsteEspacio}
          title={enEsteEspacio ? undefined : t("work:docs.openAListFirst", { where: spaceName })}
        >
          <FileText className="size-4" />
          {t("work:docs.saveToDocs")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {DOC_TABS.map((k) => (
            <DropdownMenuItem key={k} onClick={() => void guardar(k)}>
              {t(ROTULOS[k])}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DecisionForm
        open={decidiendo}
        onOpenChange={setDecidiendo}
        onSubmit={async (d) => {
          if (!activeListId) return;
          await addDecisionTo("list", activeListId, {
            ...d,
            origin: "message",
            originMessageId: messageId,
            originChannelId: spaceId,
          });
          toast.success(t("work:decisions.saved"));
        }}
      />
    </>
  );
}
