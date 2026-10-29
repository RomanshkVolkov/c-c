import { useState } from "react";
import { CheckSquare, Hash, Link2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { useConfirm } from "@/components/ConfirmDialog";
import DecisionLinkPicker, { type PickedLink } from "@/components/docs/DecisionLinkPicker";
import { sectionHref } from "@/lib/doc-sections";
import { useT } from "@/lib/i18n";
import { useTasksStore } from "@/store/tasks.store";
import type { Decision, DecisionLink } from "@/types/task";

/**
 * A qué se aplica una decisión, en su entrada del registro
 * (command-and-control-91): las tareas que toca y las secciones que la llevan
 * a cabo. Una tarea abre su cajón; una sección lleva a ella. Una sección que
 * ya no está sale tachada con el título que tenía: que la decisión se aplicaba
 * a algo que se quitó también es un dato.
 *
 * Quitar un enlace pregunta antes, y no lo borra: queda quién y cuándo.
 */
export default function DecisionLinks({ decision, orgId }: { decision: Decision; orgId?: string }) {
  // Un backend de antes no manda `links`: no se ofrece lo que no puede hacer.
  return decision.links === undefined ? null : <Links decision={decision} orgId={orgId} />;
}

function Links({ decision, orgId }: { decision: Decision; orgId?: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const openTask = useTasksStore((s) => s.openTask);
  const linkDecision = useTasksStore((s) => s.linkDecision);
  const unlinkDecision = useTasksStore((s) => s.unlinkDecision);
  const [picking, setPicking] = useState(false);
  const links = decision.links ?? [];

  const label = (l: DecisionLink) =>
    l.kind === "task"
      ? [l.taskRef, l.taskTitle].filter(Boolean).join(" ")
      : l.sectionRemoved
        ? t("work:decisions.sectionGone", { what: l.heading ?? "" })
        : (l.heading ?? "");

  const open = (l: DecisionLink) => {
    if (l.kind === "task" && l.taskId) {
      void openTask(l.taskId).catch(() => {});
      return;
    }
    const href = sectionHref(l);
    if (href) navigate(href);
  };

  const unlink = async (l: DecisionLink) => {
    const ok = await confirm({
      title: t("work:decisions.unlinkTitle"),
      description: t("work:decisions.unlinkBody", { what: label(l) }),
      confirmText: t("work:decisions.unlink"),
    });
    if (!ok) return;
    unlinkDecision(decision.id, l.id).catch((e) => toast.error(t("work:decisions.linkErr"), { description: String(e) }));
  };

  const add = async (picked: PickedLink[]) => {
    try {
      await linkDecision(decision.id, {
        taskIds: picked.filter((p) => p.kind === "task").map((p) => p.id),
        sectionIds: picked.filter((p) => p.kind === "section").map((p) => p.id),
      });
    } catch (e) {
      toast.error(t("work:decisions.linkErr"), { description: String(e) });
      throw e;
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" data-testid="decision-links">
      {links.length > 0 && <span className="mr-1 text-xs text-muted-foreground">{t("work:decisions.appliesTo")}</span>}
      {links.map((l) => (
        <span
          key={l.id}
          data-removed={l.sectionRemoved ? "true" : undefined}
          className={"group flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs" + (l.sectionRemoved ? " line-through opacity-60" : "")}
        >
          <button type="button" onClick={() => open(l)} className="flex items-center gap-1 hover:underline">
            {l.kind === "task" ? <CheckSquare className="size-3" /> : <Hash className="size-3" />}
            {label(l)}
          </button>
          <button
            type="button"
            onClick={() => void unlink(l)}
            aria-label={t("work:decisions.unlink")}
            title={t("work:decisions.unlink")}
            className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus:opacity-100"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {orgId && (
        <>
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="motion-press flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Link2 className="size-3" />
            {t("work:decisions.link")}
          </button>
          <DecisionLinkPicker open={picking} onOpenChange={setPicking} orgId={orgId} onPick={add} />
        </>
      )}
    </div>
  );
}
