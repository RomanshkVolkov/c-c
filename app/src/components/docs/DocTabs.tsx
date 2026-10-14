import { useEffect, useRef, useState } from "react";
import { FileText, Gavel, Loader2, Pencil, X } from "lucide-react";
import { toast } from "sonner";

import DecisionForm from "@/components/docs/DecisionForm";
import DecisionList from "@/components/docs/DecisionList";
import DocHeader from "@/components/docs/DocHeader";
import DocHistory from "@/components/docs/DocHistory";
import ShareDoc from "@/components/docs/ShareDoc";
import SaveChip from "@/components/docs/SaveChip";
import TemplatePicker from "@/components/docs/TemplatePicker";
import { useAutoguardado } from "@/hooks/use-autoguardado";
import DocToc from "@/components/docs/DocToc";
import { docLinks } from "@/components/docs/doc-links";
import DocPagesSheet from "@/components/docs/DocPagesSheet";
import DocPageView from "@/components/docs/DocPageView";
import Markdown from "@/components/markdown/Markdown";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { useT, type MessageKey } from "@/lib/i18n";
import { codigoDe } from "@/lib/api";
import { openInternalRef } from "@/lib/open-ref";
import { openAttachment } from "@/lib/media";
import PdfPreview from "@/components/PdfPreview";
import { isPdfFile } from "@/components/PdfAttachment";
import { cn } from "@/lib/utils";
import CopyId from "@/components/CopyId";
import ViewSwitch, { type ListView } from "@/components/tasks/ViewSwitch";
import ListToolbar from "@/components/tasks/ListToolbar";
import { useTasksStore } from "@/store/tasks.store";
import { useDocPages } from "@/store/doc-pages.store";
import { DOC_TABS, type DocTabKey } from "@/types/task";

/**
 * La documentación de un nodo, en cuatro secciones.
 *
 * Sustituye al viejo `DocView`, que era un markdown único. Lo que había escrito pasa a
 * **Resumen** — nadie escribió un runbook en un campo llamado «body», escribió
 * lo que sabía del proyecto.
 *
 * Las cuatro están **siempre**, y una vacía se ve en gris en vez de esconderse:
 * su ausencia es información. Que un proyecto no tenga runbook es un dato sobre
 * el proyecto, no una pestaña que estorbe.
 */

const TAB_LABELS: Record<DocTabKey, { label: MessageKey; hint: MessageKey }> = {
  overview: { label: "work:docs.overview", hint: "work:docs.overviewHint" },
  runbook: { label: "work:docs.runbook", hint: "work:docs.runbookHint" },
  decisions: { label: "work:docs.decisions", hint: "work:docs.decisionsHint" },
  links: { label: "work:docs.links", hint: "work:docs.linksHint" },
};

/** El índice sólo donde aporta. En una lista de entradas repetiría lo que se ve. */
const WITH_TOC: DocTabKey[] = ["overview", "runbook"];

export default function DocTabs({
  onView,
  inDocsPanel = false,
}: {
  onView: (v: Exclude<ListView, "docs">) => void;
  /** En `/docs` las páginas están en el panel de al lado; fuera, tras un botón. */
  inDocsPanel?: boolean;
}) {
  const { t } = useT();
  const target = useTasksStore((s) => s.activeDoc);
  const doc = useTasksStore((s) => s.doc);
  const loading = useTasksStore((s) => s.loadingDoc);
  const saveDoc = useTasksStore((s) => s.saveDoc);
  const upload = useTasksStore((s) => s.uploadDocAttachment);
  const closeDoc = useTasksStore((s) => s.closeDoc);
  const addDecision = useTasksStore((s) => s.addDecision);
  const openDoc = useTasksStore((s) => s.openDoc);

  const activePageId = useDocPages((s) => s.activePageId);
  const pageView = useDocPages((s) => s.view);
  const enterPages = useDocPages((s) => s.enter);

  const [activeTab, setActiveTab] = useState<DocTabKey>("overview");
  const [editing, setEditing] = useState(false);
  // El PDF adjunto que se está viendo, en el visor de la app.
  const [pdf, setPdf] = useState<{ url: string; fileName: string } | null>(null);
  const [draft, setDraft] = useState("");
  // Cuando alguien pulsa «empezar en blanco» sobre un nodo sin nada escrito: no
  // hay documento que enseñar y tampoco hay que volver a ofrecer las plantillas.
  const [skipTemplates, setSkipTemplates] = useState(false);
  const [addingDecision, setAddingDecision] = useState(false);

  const section = doc?.tabs?.find((x) => x.key === activeTab);
  const body = section?.body ?? "";
  const sectionHash = section?.bodyHash;
  const nothingWritten = !doc?.tabs?.some((x) => x.body);

  /**
   * A qué sección pertenece el borrador, que **no** siempre es la activa.
   *
   * Al cambiar de pestaña se apaga el editor, y apagarlo fuerza un guardado de
   * lo que quedaba pendiente. Para entonces `activeTab` ya es la nueva mientras el
   * texto sigue siendo el de la vieja: sin esto, cambiar de Resumen a Runbook
   * escribía el resumen encima del runbook. Se pierde el runbook entero y nadie
   * lo ve hasta que va a leerlo.
   *
   * Esta referencia sólo avanza cuando el borrador adopta un texto nuevo, que es
   * después de ese guardado — así que el guardado sale con la sección correcta.
   */
  const draftSection = useRef<DocTabKey>(activeTab);
  /**
   * De qué versión salió el borrador.
   *
   * Va con la sección y por la misma razón: se fija cuando el borrador adopta un
   * texto, no cuando cambia la pestaña activa. Sin él el servidor rechaza el
   * guardado —una petición sin hash es, para él, una copia anterior a la primera
   * versión que se hasheó— y con el de otra sección rechazaría también.
   */
  const draftHash = useRef<string | undefined>(undefined);
  // Alguien guardó esta sección mientras se escribía. Ver el `catch` de abajo.
  const [conflicted, setConflicted] = useState(false);

  // El guardado va por tiempo, no por botón. Ver `use-autoguardado`: lo delicado
  // no es el temporizador, es no perder lo que se escribe mientras uno viaja.
  const { estado: saveState, adoptar: adopt } = useAutoguardado(
    draft,
    async (text) => {
      try {
        draftHash.current = await saveDoc(text, draftSection.current, draftHash.current);
      } catch (e) {
        // Alguien —o un agente por MCP— guardó esta sección mientras se escribía.
        //
        // El editor **se queda abierto con el borrador dentro**. Cerrarlo sería
        // tirar lo que la persona acaba de escribir para proteger lo que escribió
        // otra, que es cambiar una pérdida por otra. Lo que se para es el
        // autoguardado: seguir intentándolo con cada tecla es fallar en bucle.
        if (codigoDe(e) === "doc-conflict") {
          setConflicted(true);
          return;
        }
        throw e;
      }
    },
    // Con un choque encima no se vuelve a intentar: el siguiente guardado
    // fallaría igual, y quien escribe necesita decidir antes qué hacer con su
    // texto.
    editing && !conflicted,
  );

  // Cambiar de nodo o de sección no puede arrastrar un borrador a medias.
  useEffect(() => {
    setEditing(false);
    setConflicted(false);
  }, [target?.kind, target?.id, activeTab]);

  // Adoptar lo guardado, pero **nunca encima de lo que se está escribiendo**.
  // `body` tiene que seguir siendo dependencia: esta pantalla se pinta antes
  // de que llegue el documento, así que el primer valor siempre es "".
  useEffect(() => {
    if (editing) return;
    setDraft(body);
    draftSection.current = activeTab;
    draftHash.current = sectionHash;
    // Restaurar una versión o cambiar de sección trae texto que nadie escribió
    // aquí: sin decírselo al autoguardado, lo tomaría por una edición y lo
    // volvería a mandar, escribiendo una versión idéntica en el historial.
    adopt(body);
  }, [body, editing, adopt, activeTab, sectionHash]);

  // La pestaña que pidió un enlace (`&tab=`). Hasta ahora el enlace de
  // «compartir esta sección» la llevaba y nadie la leía: abría Resumen.
  const requestedTab = useDocPages((s) => s.requestedTab);
  useEffect(() => {
    if (!requestedTab) return;
    const tab = useDocPages.getState().takeRequestedTab();
    if (tab) setActiveTab(tab);
  }, [requestedTab]);

  // El árbol es del nodo: otro nodo, otro árbol. Ver `enter`.
  const nodeKind = target?.kind;
  const nodeId = target?.id;
  useEffect(() => {
    if (!nodeKind || !nodeId) return;
    enterPages({ kind: nodeKind, id: nodeId }).catch(() => {});
  }, [nodeKind, nodeId, enterPages]);

  if (!target) return null;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className={cn("flex h-12 shrink-0 items-center gap-2 px-4", target.kind !== "list" && "border-b")}>
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        {/* `min-w-0` además de `truncate`: dentro de un flex, un hijo no baja de
            su ancho de contenido sin esto, así que el nombre empujaba a los
            botones fuera de la ventana en vez de recortarse él. */}
        <h1 className="min-w-0 truncate text-sm font-medium">{target.name}</h1>
        <CopyId id={target.id} label={target.kind} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <DocPagesSheet kind={target.kind} ownerId={target.id} inDocsPanel={inDocsPanel} />
          {doc?.doc && (
            <ShareDoc
              doc={doc.doc}
              nombre={target.name}
              tab={activeTab}
              page={
                activePageId && pageView?.page
                  ? { id: pageView.page.id, title: pageView.page.title }
                  : undefined
              }
            />
          )}
          <Button size="icon-xs" variant="ghost" title={t("work:docs.cancel")} onClick={closeDoc}>
            <X className="size-3.5" />
          </Button>
        </div>
      </header>

      {/* El grupo de las cuatro sólo para la documentación de una **lista**:
          un espacio o una carpeta no tienen tarjetas detrás, y ofrecer
          «Tablero» ahí llevaría a la lista de otra cosa. En su fila, debajo del
          nombre, como en el tablero (`ListToolbar`): pasar de una vista a otra
          no mueve las pestañas.
          Y no se pide además que ese tablero esté ya cargado: entrando por
          «Documentación» de la barra lateral no lo está, y el conmutador
          desaparecía sin explicación. Quien lo pulsa selecciona la lista, que
          es lo que lo carga. */}
      {target.kind === "list" && (
        <ListToolbar
          views={
            <ViewSwitch
              value="docs"
              onChange={(v) => {
                if (v === "docs") return;
                onView(v);
                closeDoc();
              }}
            />
          }
        />
      )}

      {/* Lo que se lee, a todo el ancho. Las páginas que cuelgan de la portada
          están en el panel de Documentación del sidebar (12-oct-2026), no en
          una columna aquí al lado; en el teléfono, tras el botón «Páginas» de
          la cabecera. La portada sigue siendo lo de siempre, con sus cuatro
          pestañas. */}
      <div className="flex min-h-0 flex-1">
        {activePageId ? (
          <DocPageView
            kind={target.kind}
            ownerId={target.id}
            nodeName={target.name}
            onInternalLink={(href) => openInternalRef(href)}
          />
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Responsable y frescura, entre el título y las pestañas: pertenecen al
          documento entero, no a la sección que se esté mirando. Sólo cuando ya
          existe — en un nodo sin nada escrito todavía no hay nada que revisar. */}
            {doc?.doc && <DocHeader doc={doc.doc} />}

            {/* Las cuatro, siempre. La vacía en gris — ver el comentario de arriba. */}
            {/* Se desliza antes que recortarse.
          Cuatro pestañas con su pista al lado no caben en una ventana estrecha, y
          lo que se perdía era la última —«Enlaces»— sin ninguna señal de que
          estuviera ahí. La pista desaparece primero porque es lo prescindible; el
          deslizamiento es la red por si aun así no caben. */}
            <nav className="flex shrink-0 gap-4 overflow-x-auto border-b px-4 text-sm">
              {DOC_TABS.map((k) => {
                // La de decisiones no se mide por su markdown —no tiene—: se mide
                // por si hay entradas. Sin esto siempre saldría en gris, incluso con
                // el registro lleno.
                const empty =
                  k === "decisions"
                    ? (doc?.decisions?.length ?? 0) === 0
                    : !doc?.tabs?.find((x) => x.key === k)?.body;
                return (
                  <button
                    key={k}
                    onClick={() => setActiveTab(k)}
                    className={cn(
                      "flex shrink-0 items-baseline gap-1.5 whitespace-nowrap border-b-2 pb-2 pt-2",
                      k === activeTab
                        ? "border-primary font-medium text-foreground"
                        : "border-transparent hover:text-foreground",
                      empty && k !== activeTab ? "text-muted-foreground/60" : "text-muted-foreground",
                    )}
                  >
                    {t(TAB_LABELS[k].label)}
                    <span className="hidden text-[11px] text-muted-foreground/70 md:inline">
                      {t(TAB_LABELS[k].hint)}
                    </span>
                  </button>
                );
              })}
            </nav>

            <div data-doc-scroll className="min-h-0 flex-1 overflow-auto p-6">
              {loading && !doc ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> {t("common:servers.loading")}
                </p>
              ) : editing ? (
                <div className="mx-auto max-w-3xl space-y-2">
                  <MarkdownEditor
                    value={draft}
                    onChange={setDraft}
                    onUpload={upload}
                    collapsible
                    blockTools
                  docLinks={docLinks}
                    minHeight="24rem"
                    placeholder={t("work:docs.placeholder")}
                    autoFocus
                  />
                  {conflicted && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/[.07] px-3 py-2 text-xs">
                      <p className="font-medium text-foreground">{t("work:docs.conflict")}</p>
                      <p className="mt-0.5 text-muted-foreground">{t("work:docs.conflictWhy")}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2 h-6 text-xs"
                        onClick={() => {
                          setConflicted(false);
                          setEditing(false);
                          if (target) void openDoc(target.kind, target.id, target.name).catch(() => {});
                        }}
                      >
                        {t("work:docs.discardAndReload")}
                      </Button>
                    </div>
                  )}
                  {/* Ya no hay «Guardar» ni «Cancelar»: se guarda solo, así que
                cancelar no cancelaría nada. Para deshacer está el historial,
                que es lo que hace soportable escribir sin botón. */}
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                      {t("work:docs.done")}
                    </Button>
                    <SaveChip estado={saveState} />
                  </div>
                </div>
              ) : activeTab === "decisions" ? (
                // El registro no es markdown: cada entrada lleva fecha, autor y de
                // dónde salió, y en un markdown suelto eso se escribe a mano, se
                // escribe mal y se deja de escribir.
                <DecisionList decisions={doc?.decisions ?? []} />
              ) : (
                <div className="mx-auto flex w-full min-w-0 max-w-4xl xl:max-w-5xl xl:gap-8">
                  <div className="min-w-0 flex-1">
                    {body ? (
                      // Medida de línea corta y texto más grande: es un documento,
                      // no un panel. `prose-doc` lo fija en un solo sitio.
                      <div className="prose-doc">
                        <Markdown allowHtml includes onInternalLink={(href) => openInternalRef(href)}>
                          {body}
                        </Markdown>
                      </div>
                    ) : nothingWritten && !skipTemplates ? (
                      // Las plantillas sólo cuando el documento entero está vacío. En
                      // una pestaña suelta de un documento que ya existe estorban:
                      // ahí lo que falta es un runbook, no un proyecto.
                      <TemplatePicker onWritten={() => setSkipTemplates(true)} />
                    ) : (
                      <div className="py-12 text-center">
                        <p className="text-sm text-muted-foreground">{t("work:docs.emptyTab")}</p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-3"
                          onClick={() => setEditing(true)}
                        >
                          <Pencil className="mr-1 size-3" /> {t("work:docs.writeIt")}
                        </Button>
                      </div>
                    )}
                  </div>
                  {WITH_TOC.includes(activeTab) && body && <DocToc markdown={body} />}
                </div>
              )}
            </div>

            {activeTab === "decisions" && (
              <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
                <Button size="sm" variant="ghost" onClick={() => setAddingDecision(true)}>
                  <Gavel className="mr-1 size-3" /> {t("work:decisions.record")}
                </Button>
              </footer>
            )}

            {!editing && body && activeTab !== "decisions" && (
              <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil className="mr-1 size-3" /> {t("work:docs.edit")}
                </Button>
                <DocHistory tab={activeTab} current={body} />
                {doc?.attachments && doc.attachments.length > 0 && (
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    {doc.attachments.map((a) => (
                      <button
                        key={a.id}
                        className="truncate underline hover:text-foreground"
                        // Un PDF, en el visor de la app; lo demás, a su programa.
                        onClick={() =>
                          isPdfFile(a.fileName)
                            ? setPdf({ url: a.url, fileName: a.fileName })
                            : openAttachment(a.url, a.fileName).catch((e) => toast.error(String(e)))
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
        )}
      </div>
      {pdf && <PdfPreview {...pdf} onClose={() => setPdf(null)} />}
      <DecisionForm
        open={addingDecision}
        onOpenChange={setAddingDecision}
        onSubmit={async (d) => {
          await addDecision(d);
          toast.success(t("work:decisions.saved"));
        }}
      />
    </div>
  );
}
