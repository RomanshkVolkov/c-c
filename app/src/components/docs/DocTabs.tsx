import { useEffect, useState } from "react";
import { FileText, Loader2, Pencil, X } from "lucide-react";
import { toast } from "sonner";

import DocToc from "@/components/docs/DocToc";
import Markdown from "@/components/markdown/Markdown";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { useT, type MessageKey } from "@/lib/i18n";
import { openAttachment } from "@/lib/media";
import { cn } from "@/lib/utils";
import CopyId from "@/components/CopyId";
import { useTasksStore } from "@/store/tasks.store";
import { DOC_TABS, type DocTabKey } from "@/types/task";

/**
 * La documentación de un nodo, en cuatro secciones.
 *
 * Sustituye a `DocView`, que era un markdown único. Lo que había escrito pasa a
 * **Resumen** — nadie escribió un runbook en un campo llamado «body», escribió
 * lo que sabía del proyecto.
 *
 * Las cuatro están **siempre**, y una vacía se ve en gris en vez de esconderse:
 * su ausencia es información. Que un proyecto no tenga runbook es un dato sobre
 * el proyecto, no una pestaña que estorbe.
 */

const ROTULOS: Record<DocTabKey, { label: MessageKey; hint: MessageKey }> = {
  overview: { label: "work:docs.overview", hint: "work:docs.overviewHint" },
  runbook: { label: "work:docs.runbook", hint: "work:docs.runbookHint" },
  decisions: { label: "work:docs.decisions", hint: "work:docs.decisionsHint" },
  links: { label: "work:docs.links", hint: "work:docs.linksHint" },
};

/** El índice sólo donde aporta. En una lista de entradas repetiría lo que se ve. */
const CON_INDICE: DocTabKey[] = ["overview", "runbook"];

export default function DocTabs() {
  const { t } = useT();
  const target = useTasksStore((s) => s.activeDoc);
  const doc = useTasksStore((s) => s.doc);
  const loading = useTasksStore((s) => s.loadingDoc);
  const saveDoc = useTasksStore((s) => s.saveDoc);
  const upload = useTasksStore((s) => s.uploadDocAttachment);
  const closeDoc = useTasksStore((s) => s.closeDoc);

  const [activa, setActiva] = useState<DocTabKey>("overview");
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState("");
  const [guardando, setGuardando] = useState(false);

  const cuerpo = doc?.tabs?.find((x) => x.key === activa)?.body ?? "";

  // Cambiar de nodo o de sección no puede arrastrar un borrador a medias.
  useEffect(() => {
    setEditando(false);
  }, [target?.kind, target?.id, activa]);

  // Adoptar lo guardado, pero **nunca encima de lo que se está escribiendo**.
  // `cuerpo` tiene que seguir siendo dependencia: esta pantalla se pinta antes
  // de que llegue el documento, así que el primer valor siempre es "".
  useEffect(() => {
    if (editando) return;
    setBorrador(cuerpo);
  }, [cuerpo, editando]);

  if (!target) return null;

  const guardar = async () => {
    setGuardando(true);
    try {
      await saveDoc(borrador, activa);
      setEditando(false);
      toast.success(t("work:docs.saved"));
    } catch (e) {
      toast.error(t("work:docs.errSave"), { description: String(e) });
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="truncate text-sm font-medium">{target.name}</h1>
        <CopyId id={target.id} label={target.kind} />
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          title={t("work:docs.cancel")}
          onClick={closeDoc}
        >
          <X className="size-3.5" />
        </Button>
      </header>

      {/* Las cuatro, siempre. La vacía en gris — ver el comentario de arriba. */}
      <nav className="flex shrink-0 gap-4 border-b px-4 text-sm">
        {DOC_TABS.map((k) => {
          const vacia = !doc?.tabs?.find((x) => x.key === k)?.body;
          return (
            <button
              key={k}
              onClick={() => setActiva(k)}
              className={cn(
                "flex items-baseline gap-1.5 border-b-2 pb-2 pt-2",
                k === activa
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent hover:text-foreground",
                vacia && k !== activa ? "text-muted-foreground/60" : "text-muted-foreground",
              )}
            >
              {t(ROTULOS[k].label)}
              <span className="text-[11px] text-muted-foreground/70">{t(ROTULOS[k].hint)}</span>
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {loading && !doc ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t("common:servers.loading")}
          </p>
        ) : editando ? (
          <div className="mx-auto max-w-3xl space-y-2">
            <MarkdownEditor
              value={borrador}
              onChange={setBorrador}
              onUpload={upload}
              collapsible
              blockTools
              minHeight="24rem"
              placeholder={t("work:docs.placeholder")}
              autoFocus
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void guardar()} disabled={guardando}>
                {guardando && <Loader2 className="mr-1 size-3 animate-spin" />}
                {t("work:docs.save")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBorrador(cuerpo);
                  setEditando(false);
                }}
              >
                {t("work:docs.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-4xl gap-8">
            <div className="min-w-0 flex-1">
              {cuerpo ? (
                // Medida de línea corta y texto más grande: es un documento,
                // no un panel. `prose-doc` lo fija en un solo sitio.
                <div className="prose-doc">
                  <Markdown allowHtml>{cuerpo}</Markdown>
                </div>
              ) : (
                <div className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">{t("work:docs.emptyTab")}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => setEditando(true)}
                  >
                    <Pencil className="mr-1 size-3" /> {t("work:docs.writeIt")}
                  </Button>
                </div>
              )}
            </div>
            {CON_INDICE.includes(activa) && cuerpo && <DocToc markdown={cuerpo} />}
          </div>
        )}
      </div>

      {!editando && cuerpo && (
        <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setEditando(true)}>
            <Pencil className="mr-1 size-3" /> {t("work:docs.edit")}
          </Button>
          {doc?.attachments && doc.attachments.length > 0 && (
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              {doc.attachments.map((a) => (
                <button
                  key={a.id}
                  className="truncate underline hover:text-foreground"
                  onClick={() =>
                    openAttachment(a.url, a.fileName).catch((e) => toast.error(String(e)))
                  }
                >
                  {a.fileName}
                </button>
              ))}
            </span>
          )}
        </footer>
      )}
    </div>
  );
}
