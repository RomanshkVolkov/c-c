import { useEffect, useRef, useState } from "react";
import { ChevronRight, ClipboardList, FileText, KanbanSquare, Loader2, Pencil, Plus, Puzzle, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { VersionMenu } from "@/components/docs/DocHistory";
import DocToc from "@/components/docs/DocToc";
import { docLinks } from "@/components/docs/doc-links";
import { useTrashPage } from "@/components/docs/use-trash-page";
import SaveChip from "@/components/docs/SaveChip";
import Markdown from "@/components/markdown/Markdown";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { useAutoguardado } from "@/hooks/use-autoguardado";
import { codigoDe } from "@/lib/api";
import { useT, type MessageKey } from "@/lib/i18n";
import { useDocPages } from "@/store/doc-pages.store";
import { useTasksStore } from "@/store/tasks.store";
import type { DocOwnerKind } from "@/types/task";

/**
 * Las plantillas de una página. No son las de la portada (proyecto, servicio,
 * cliente, integración), que describen un nodo entero: una página es una pieza
 * —un componente, un procedimiento— y se le pregunta otra cosa.
 */
const PLANTILLAS = [
  { key: "component", icon: Puzzle },
  { key: "procedure", icon: ClipboardList },
] as const;

/**
 * Una página de un documento, abierta.
 *
 * Lo mismo que una pestaña de la portada —el mismo editor, el mismo
 * autoguardado, la misma detección de conflicto— más lo que hace de esto una
 * página de wiki: las migas de pan arriba (de dónde cuelga), el título
 * editable, y al pie las páginas que tiene dentro, como la macro «Children» de
 * Confluence, siempre puesta.
 */
export default function DocPageView({
  kind,
  ownerId,
  nodeName,
  onInternalLink,
}: {
  kind: DocOwnerKind;
  ownerId: string;
  nodeName: string;
  onInternalLink?: (href: string) => boolean;
}) {
  const { t } = useT();
  const view = useDocPages((s) => s.view);
  const loading = useDocPages((s) => s.loadingPage);
  const openPage = useDocPages((s) => s.openPage);
  const closePage = useDocPages((s) => s.closePage);
  const savePage = useDocPages((s) => s.savePage);
  const createPage = useDocPages((s) => s.createPage);
  const pageVersions = useDocPages((s) => s.pageVersions);
  const restorePageVersion = useDocPages((s) => s.restorePageVersion);
  const tirar = useTrashPage(kind, ownerId);
  const upload = useTasksStore((s) => s.uploadDocAttachment);
  const owner = { kind, id: ownerId };

  const page = view?.page;
  const [titulo, setTitulo] = useState("");
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState("");
  const [chocado, setChocado] = useState(false);
  /** De qué página y de qué versión salió el borrador. Ver `DocTabs`. */
  const paginaDelBorrador = useRef<string | undefined>(undefined);
  const hashDelBorrador = useRef<string | undefined>(undefined);

  const { estado, adoptar } = useAutoguardado(
    borrador,
    async (texto) => {
      const id = paginaDelBorrador.current;
      if (!id) return;
      try {
        hashDelBorrador.current = await savePage(owner, id, { body: texto }, hashDelBorrador.current);
      } catch (e) {
        // Alguien —o un agente por MCP— guardó esta página mientras se
        // escribía. El borrador se queda; se para el autoguardado.
        if (codigoDe(e) === "doc-page-conflict") {
          setChocado(true);
          return;
        }
        throw e;
      }
    },
    editando && !chocado,
  );

  // Otra página: fuera el editor.
  useEffect(() => {
    setEditando(false);
    setChocado(false);
  }, [page?.id]);

  // Adoptar lo guardado, nunca encima de lo que se escribe.
  useEffect(() => {
    if (editando || !page) return;
    setBorrador(page.body);
    setTitulo(page.title);
    paginaDelBorrador.current = page.id;
    hashDelBorrador.current = page.bodyHash;
    adoptar(page.body);
  }, [page, editando, adoptar]);

  if (loading && !view) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {t("common:servers.loading")}
      </p>
    );
  }
  if (!page || !view) return null;

  const guardarTitulo = async () => {
    const limpio = titulo.trim();
    if (limpio === page.title) return;
    try {
      await savePage(owner, page.id, { title: limpio });
    } catch (e) {
      toast.error(String((e as Error)?.message ?? e));
      setTitulo(page.title);
    }
  };

  // Una plantilla se escribe ya y se abre el editor encima: lo que da es la
  // estructura, y lo siguiente que se hace es rellenarla.
  const usarPlantilla = async (cuerpo: string) => {
    try {
      hashDelBorrador.current = await savePage(owner, page.id, { body: cuerpo }, hashDelBorrador.current);
      setBorrador(cuerpo);
      adoptar(cuerpo);
      setEditando(true);
    } catch (e) {
      toast.error(t("work:docs.errSave"), { description: String(e) });
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div data-doc-scroll className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto flex w-full min-w-0 max-w-4xl xl:max-w-5xl xl:gap-8">
          <div className="min-w-0 flex-1">
            {/* Las migas de pan: de dónde cuelga, hasta la portada. */}
            <nav aria-label="breadcrumb" className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <button type="button" className="hover:text-foreground hover:underline" onClick={closePage}>
                {nodeName}
              </button>
              {view.breadcrumb.map((c) => (
                <span key={c.id} className="flex items-center gap-1">
                  <ChevronRight className="size-3" />
                  <button type="button" className="hover:text-foreground hover:underline" onClick={() => void openPage(owner, c.id)}>
                    {c.title || t("work:docs.untitled")}
                  </button>
                </span>
              ))}
            </nav>
            <input
              aria-label={t("work:docs.pageTitle")}
              value={titulo}
              placeholder={t("work:docs.untitled")}
              onChange={(e) => setTitulo(e.target.value)}
              onBlur={() => void guardarTitulo()}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="mb-4 w-full bg-transparent text-2xl font-semibold outline-none placeholder:text-muted-foreground/50"
            />

            {editando ? (
              <div className="space-y-2">
                <MarkdownEditor
                  value={borrador}
                  onChange={setBorrador}
                  onUpload={upload}
                  collapsible
                  blockTools
                  docLinks={docLinks}
                  minHeight="24rem"
                  placeholder={t("work:docs.pagePlaceholder")}
                  autoFocus
                />
                {chocado && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/[.07] px-3 py-2 text-xs">
                    <p className="font-medium text-foreground">{t("work:docs.conflict")}</p>
                    <p className="mt-0.5 text-muted-foreground">{t("work:docs.conflictWhy")}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-6 text-xs"
                      onClick={() => {
                        setChocado(false);
                        setEditando(false);
                        void openPage(owner, page.id);
                      }}
                    >
                      {t("work:docs.discardAndReload")}
                    </Button>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditando(false)}>
                    {t("work:docs.done")}
                  </Button>
                  <SaveChip estado={estado} />
                </div>
              </div>
            ) : page.body ? (
              <div className="prose-doc">
                <Markdown allowHtml onInternalLink={onInternalLink}>
                  {page.body}
                </Markdown>
              </div>
            ) : (
              // Vacía: por dónde empezar, como la portada con sus plantillas.
              // Una página en blanco es la misma pregunta sin enunciado.
              <div className="py-8">
                <p className="text-center text-sm text-muted-foreground">{t("work:docs.emptyPage")}</p>
                <div className="mx-auto mt-4 grid max-w-lg gap-2 sm:grid-cols-2">
                  {PLANTILLAS.map(({ key, icon: Icon }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => void usarPlantilla(t(`work:pageTemplates.${key}.body` as MessageKey))}
                      className="rounded-md border p-3 text-left hover:bg-accent"
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <Icon className="size-4 text-muted-foreground" />
                        {t(`work:pageTemplates.${key}.name` as MessageKey)}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {t(`work:pageTemplates.${key}.hint` as MessageKey)}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="mt-3 text-center">
                  <Button size="sm" variant="ghost" onClick={() => setEditando(true)}>
                    <Pencil className="mr-1 size-3" /> {t("work:docs.writeIt")}
                  </Button>
                </div>
              </div>
            )}

            {/* Las hijas, siempre al pie: la página dice qué tiene dentro sin
                tener que mirar el árbol. */}
            {!editando && (
              <section className="mt-10 border-t pt-4">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-xs font-semibold uppercase text-muted-foreground">{t("work:docs.childPages")}</h2>
                  <Button size="icon-xs" variant="ghost" title={t("work:docs.newSubpage")} onClick={() => void createPage(owner, page.id, t("work:docs.untitled"))}>
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                <ul className="space-y-1">
                  {view.children.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                        onClick={() => void openPage(owner, c.id)}
                      >
                        <FileText className="size-3.5" /> {c.title || t("work:docs.untitled")}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Lo que enlaza aquí, como el «Linked from» de Notion o los
                enlaces entrantes de Confluence: dice qué se rompe —o qué hay
                que actualizar— antes de mover o tirar esta página. */}
            {!editando && (view.referencedFrom?.length ?? 0) > 0 && (
              <section className="mt-6">
                <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  {t("work:docs.referencedFrom")}
                </h2>
                <ul className="space-y-1">
                  {view.referencedFrom!.map((r) => (
                    <li key={r.link}>
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-1.5 text-left text-sm"
                        onClick={() => onInternalLink?.(r.link)}
                      >
                        {r.kind === "task" ? (
                          <KanbanSquare className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate text-primary hover:underline">
                          {r.kind === "tab"
                            ? `${r.title} · ${t(`work:docs.${r.where}` as MessageKey)}`
                            : r.title || t("work:docs.untitled")}
                        </span>
                        {r.kind !== "tab" && r.where && (
                          <span className="shrink-0 truncate text-xs text-muted-foreground">{r.where}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          {!editando && page.body && <DocToc markdown={page.body} />}
        </div>
      </div>

      {!editando && (
        <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
          {page.body && (
            <Button size="sm" variant="ghost" onClick={() => setEditando(true)}>
              <Pencil className="mr-1 size-3" /> {t("work:docs.edit")}
            </Button>
          )}
          <VersionMenu
            current={page.body}
            load={() => pageVersions(owner, page.id)}
            restore={(v) => restorePageVersion(owner, page.id, v)}
          />
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            onClick={() => void tirar(page.id, page.title)}
          >
            <Trash2 className="mr-1 size-3" /> {t("work:docs.trashPage")}
          </Button>
        </footer>
      )}
    </div>
  );
}
