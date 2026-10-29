import { useEffect, useRef, useState } from "react";
import { CheckSquare, Hash, Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useTasksStore } from "@/store/tasks.store";
import type { APIResponse } from "@/types/auth";
import type { DocSectionHit } from "@/types/task";

/**
 * Elegir a qué se aplica una decisión: tareas y secciones de documentos de la
 * org (command-and-control-91).
 *
 * Busca en los dos sitios a la vez y deja elegir varias. No escribe nada: lo
 * elegido vuelve a quien lo abrió, que es quien sabe si va con una decisión
 * nueva o con una que ya existe.
 */

export interface PickedLink {
  kind: "task" | "section";
  id: string;
  label: string;
}

interface TaskHit {
  id: string;
  title: string;
  where?: string;
}

/** Dónde vive una sección, en palabras: «Proyecto › Runbook › Desplegar». */
export function sectionLabel(s: DocSectionHit, tabName: (tab: string) => string): string {
  const where = s.pageTitle || (s.tab ? tabName(s.tab) : "");
  return [s.ownerName, where, s.heading].filter(Boolean).join(" › ");
}

export default function DecisionLinkPicker({
  open,
  onOpenChange,
  orgId,
  initial = [],
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orgId: string;
  initial?: PickedLink[];
  onPick: (links: PickedLink[]) => Promise<void> | void;
}) {
  const { t } = useT();
  const searchDocSections = useTasksStore((s) => s.searchDocSections);
  const [q, setQ] = useState("");
  const [tasks, setTasks] = useState<TaskHit[]>([]);
  const [sections, setSections] = useState<DocSectionHit[]>([]);
  const [picked, setPicked] = useState<PickedLink[]>(initial);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);

  useEffect(() => {
    if (open) setPicked(initial);
    // Sólo al abrir: `initial` cambia de identidad en cada pintado de quien llama.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Cada respuesta lleva el número de la petición que la pidió: una lenta de
    // antes no pisa a una de después.
    const mine = ++asked.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const [secs, found] = await Promise.all([
          searchDocSections(orgId, q.trim()),
          q.trim().length >= 2
            ? api
                .get<APIResponse<{ tasks?: TaskHit[] }>>(
                  `/api/v1/search/?orgId=${encodeURIComponent(orgId)}&q=${encodeURIComponent(q.trim())}`,
                  true,
                )
                .then((r) => r.data?.tasks ?? [])
            : Promise.resolve([] as TaskHit[]),
        ]);
        if (mine === asked.current) {
          setSections(secs);
          setTasks(found);
        }
      } catch {
        if (mine === asked.current) {
          setSections([]);
          setTasks([]);
        }
      } finally {
        if (mine === asked.current) setLoading(false);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [q, open, orgId, searchDocSections]);

  const isPicked = (kind: PickedLink["kind"], id: string) => picked.some((p) => p.kind === kind && p.id === id);
  const toggle = (p: PickedLink) =>
    setPicked((cur) => (isPicked(p.kind, p.id) ? cur.filter((x) => !(x.kind === p.kind && x.id === p.id)) : [...cur, p]));
  const tabName = (tab: string) =>
    tab === "runbook" ? t("work:docs.runbook") : tab === "links" ? t("work:docs.links") : tab === "decisions" ? t("work:docs.decisions") : t("work:docs.overview");

  const done = async () => {
    setBusy(true);
    try {
      await onPick(picked);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("work:decisions.linkTitle")}</DialogTitle>
          <DialogDescription>{t("work:decisions.linkHint")}</DialogDescription>
        </DialogHeader>

        {picked.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="picked-links">
            {picked.map((p) => (
              <button
                key={`${p.kind}:${p.id}`}
                type="button"
                onClick={() => toggle(p)}
                className="motion-press flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
              >
                {p.kind === "task" ? <CheckSquare className="size-3" /> : <Hash className="size-3" />}
                {p.label}
                <X className="size-3" />
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 rounded-md border px-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("work:decisions.linkSearch")}
            aria-label={t("work:decisions.linkSearch")}
            className="h-9 w-full bg-transparent text-sm outline-none"
          />
          {loading && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>

        <div className="max-h-72 space-y-3 overflow-y-auto">
          {tasks.length > 0 && (
            <section>
              <h4 className="mb-1 text-xs text-muted-foreground">{t("work:decisions.linkTasks")}</h4>
              {tasks.map((h) => {
                const p: PickedLink = { kind: "task", id: h.id, label: h.title };
                return (
                  <label key={h.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                    <input type="checkbox" checked={isPicked("task", h.id)} onChange={() => toggle(p)} />
                    <span className="truncate">{h.title}</span>
                    {h.where && <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{h.where}</span>}
                  </label>
                );
              })}
            </section>
          )}
          {sections.length > 0 && (
            <section>
              <h4 className="mb-1 text-xs text-muted-foreground">{t("work:decisions.linkSections")}</h4>
              {sections.map((s) => {
                const p: PickedLink = { kind: "section", id: s.id, label: sectionLabel(s, tabName) };
                return (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                    <input type="checkbox" checked={isPicked("section", s.id)} onChange={() => toggle(p)} />
                    <span className="truncate">{p.label}</span>
                  </label>
                );
              })}
            </section>
          )}
          {!loading && tasks.length === 0 && sections.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("work:decisions.linkNone")}</p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => void done()} disabled={busy}>
            {busy && <Loader2 className="mr-1 size-3 animate-spin" />}
            {t("work:decisions.linkSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
