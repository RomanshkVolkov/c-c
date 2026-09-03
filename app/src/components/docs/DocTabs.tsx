import { useEffect, useRef, useState } from "react";
import { FileText, Gavel, Loader2, Pencil, X } from "lucide-react";
import { toast } from "sonner";

import DecisionForm from "@/components/docs/DecisionForm";
import DecisionList from "@/components/docs/DecisionList";
import DocHeader from "@/components/docs/DocHeader";
import DocHistory from "@/components/docs/DocHistory";
import SaveChip from "@/components/docs/SaveChip";
import TemplatePicker from "@/components/docs/TemplatePicker";
import { useAutoguardado } from "@/hooks/use-autoguardado";
import DocToc from "@/components/docs/DocToc";
import Markdown from "@/components/markdown/Markdown";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { useT, type MessageKey } from "@/lib/i18n";
import { openAttachment } from "@/lib/media";
import { cn } from "@/lib/utils";
import CopyId from "@/components/CopyId";
import ViewSwitch, { type ListView } from "@/components/tasks/ViewSwitch";
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

export default function DocTabs({ onView }: { onView: (v: Exclude<ListView, "docs">) => void }) {
  const { t } = useT();
  const target = useTasksStore((s) => s.activeDoc);
  const doc = useTasksStore((s) => s.doc);
  const loading = useTasksStore((s) => s.loadingDoc);
  const saveDoc = useTasksStore((s) => s.saveDoc);
  const upload = useTasksStore((s) => s.uploadDocAttachment);
  const closeDoc = useTasksStore((s) => s.closeDoc);
  const addDecision = useTasksStore((s) => s.addDecision);
  const board = useTasksStore((s) => s.board);

  const [activa, setActiva] = useState<DocTabKey>("overview");
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState("");
  // Cuando alguien pulsa «empezar en blanco» sobre un nodo sin nada escrito: no
  // hay documento que enseñar y tampoco hay que volver a ofrecer las plantillas.
  const [saltarPlantillas, setSaltarPlantillas] = useState(false);
  const [registrando, setRegistrando] = useState(false);

  const cuerpo = doc?.tabs?.find((x) => x.key === activa)?.body ?? "";
  const sinNada = !doc?.tabs?.some((x) => x.body);

  /**
   * A qué sección pertenece el borrador, que **no** siempre es la activa.
   *
   * Al cambiar de pestaña se apaga el editor, y apagarlo fuerza un guardado de
   * lo que quedaba pendiente. Para entonces `activa` ya es la nueva mientras el
   * texto sigue siendo el de la vieja: sin esto, cambiar de Resumen a Runbook
   * escribía el resumen encima del runbook. Se pierde el runbook entero y nadie
   * lo ve hasta que va a leerlo.
   *
   * Esta referencia sólo avanza cuando el borrador adopta un texto nuevo, que es
   * después de ese guardado — así que el guardado sale con la sección correcta.
   */
  const seccionDelBorrador = useRef<DocTabKey>(activa);

  // El guardado va por tiempo, no por botón. Ver `use-autoguardado`: lo delicado
  // no es el temporizador, es no perder lo que se escribe mientras uno viaja.
  const { estado, adoptar } = useAutoguardado(
    borrador,
    (texto) => saveDoc(texto, seccionDelBorrador.current),
    editando,
  );

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
    seccionDelBorrador.current = activa;
    // Restaurar una versión o cambiar de sección trae texto que nadie escribió
    // aquí: sin decírselo al autoguardado, lo tomaría por una edición y lo
    // volvería a mandar, escribiendo una versión idéntica en el historial.
    adoptar(cuerpo);
  }, [cuerpo, editando, adoptar, activa]);

  if (!target) return null;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="truncate text-sm font-medium">{target.name}</h1>
        <CopyId id={target.id} label={target.kind} />
        {/* El grupo de las cuatro sólo cuando hay tablero al que volver: la
            documentación de un espacio o una carpeta no tiene tarjetas detrás,
            y ofrecer «Board» ahí llevaría a la lista de otra cosa. */}
        {target.kind === "list" && board?.list.id === target.id ? (
          <ViewSwitch
            value="docs"
            onChange={(v) => {
              if (v === "docs") return;
              onView(v);
              closeDoc();
            }}
          />
        ) : null}
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

      {/* Responsable y frescura, entre el título y las pestañas: pertenecen al
          documento entero, no a la sección que se esté mirando. Sólo cuando ya
          existe — en un nodo sin nada escrito todavía no hay nada que revisar. */}
      {doc?.doc && <DocHeader doc={doc.doc} />}

      {/* Las cuatro, siempre. La vacía en gris — ver el comentario de arriba. */}
      <nav className="flex shrink-0 gap-4 border-b px-4 text-sm">
        {DOC_TABS.map((k) => {
          // La de decisiones no se mide por su markdown —no tiene—: se mide
          // por si hay entradas. Sin esto siempre saldría en gris, incluso con
          // el registro lleno.
          const vacia =
            k === "decisions"
              ? (doc?.decisions?.length ?? 0) === 0
              : !doc?.tabs?.find((x) => x.key === k)?.body;
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
            {/* Ya no hay «Guardar» ni «Cancelar»: se guarda solo, así que
                cancelar no cancelaría nada. Para deshacer está el historial,
                que es lo que hace soportable escribir sin botón. */}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditando(false)}>
                {t("work:docs.done")}
              </Button>
              <SaveChip estado={estado} />
            </div>
          </div>
        ) : activa === "decisions" ? (
          // El registro no es markdown: cada entrada lleva fecha, autor y de
          // dónde salió, y en un markdown suelto eso se escribe a mano, se
          // escribe mal y se deja de escribir.
          <DecisionList decisions={doc?.decisions ?? []} />
        ) : (
          <div className="mx-auto flex w-full max-w-4xl gap-8">
            <div className="min-w-0 flex-1">
              {cuerpo ? (
                // Medida de línea corta y texto más grande: es un documento,
                // no un panel. `prose-doc` lo fija en un solo sitio.
                <div className="prose-doc">
                  <Markdown allowHtml>{cuerpo}</Markdown>
                </div>
              ) : sinNada && !saltarPlantillas ? (
                // Las plantillas sólo cuando el documento entero está vacío. En
                // una pestaña suelta de un documento que ya existe estorban:
                // ahí lo que falta es un runbook, no un proyecto.
                <TemplatePicker onWritten={() => setSaltarPlantillas(true)} />
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

      {activa === "decisions" && (
        <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setRegistrando(true)}>
            <Gavel className="mr-1 size-3" /> {t("work:decisions.record")}
          </Button>
        </footer>
      )}

      {!editando && cuerpo && activa !== "decisions" && (
        <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setEditando(true)}>
            <Pencil className="mr-1 size-3" /> {t("work:docs.edit")}
          </Button>
          <DocHistory tab={activa} />
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
      <DecisionForm
        open={registrando}
        onOpenChange={setRegistrando}
        onSubmit={async (d) => {
          await addDecision(d);
          toast.success(t("work:decisions.saved"));
        }}
      />
    </div>
  );
}
