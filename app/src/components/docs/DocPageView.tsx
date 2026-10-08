import { useEffect, useRef, useState } from "react";
import { ChevronRight, FileText, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/ConfirmDialog";
import DocToc from "@/components/docs/DocToc";
import SaveChip from "@/components/docs/SaveChip";
import Markdown from "@/components/markdown/Markdown";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { useAutoguardado } from "@/hooks/use-autoguardado";
import { codigoDe } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useDocPages } from "@/store/doc-pages.store";
import { useTasksStore } from "@/store/tasks.store";
import type { DocOwnerKind } from "@/types/task";

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
  const confirm = useConfirm();
  const view = useDocPages((s) => s.view);
  const loading = useDocPages((s) => s.loadingPage);
  const openPage = useDocPages((s) => s.openPage);
  const closePage = useDocPages((s) => s.closePage);
  const savePage = useDocPages((s) => s.savePage);
  const createPage = useDocPages((s) => s.createPage);
  const trashPage = useDocPages((s) => s.trashPage);
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

  const papelera = async () => {
    const ok = await confirm({
      title: t("work:docs.trashPageTitle", { title: page.title || t("work:docs.untitled") }),
      description: t("work:docs.trashPageWhy"),
      confirmText: t("work:docs.trashPage"),
      destructive: true,
    });
    if (!ok) return;
    try {
      const n = await trashPage(owner, page.id);
      toast.success(t("work:docs.trashed", { count: Math.max(0, n - 1) }));
    } catch (e) {
      toast.error(String((e as Error)?.message ?? e));
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto flex w-full min-w-0 max-w-4xl gap-8">
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
                  minHeight="24rem"
                  placeholder={t("work:docs.placeholder")}
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
              <div className="py-10 text-center">
                <p className="text-sm text-muted-foreground">{t("work:docs.emptyPage")}</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => setEditando(true)}>
                  <Pencil className="mr-1 size-3" /> {t("work:docs.writeIt")}
                </Button>
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
          <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => void papelera()}>
            <Trash2 className="mr-1 size-3" /> {t("work:docs.trashPage")}
          </Button>
        </footer>
      )}
    </div>
  );
}
