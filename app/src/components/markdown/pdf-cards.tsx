import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createRoot, type Root } from "react-dom/client";
import PdfCard from "@/components/PdfCard";
import { isPdfAttachment } from "@/lib/media";

/**
 * La tarjeta del PDF (primera página, como en Slack) también en el editor:
 * notas y descripciones se ven siempre editando, y ahí un PDF adjunto era sólo
 * un enlace con su nombre (jose, 6-oct-2026).
 *
 * Es una **decoración**, no un nodo: se pinta en lugar del enlace, pero no
 * existe en el documento, así que el markdown que se guarda no cambia. El
 * texto del enlace queda escondido detrás de la tarjeta (como en lectura, sólo
 * se ve la tarjeta), y por eso la tarjeta trae su botón de quitar: borrar un
 * texto que no se ve no es una forma de quitar nada.
 */
export interface PdfCardsOptions {
  onOpen: (pdf: { url: string; fileName: string }) => void;
  /** Pregunta antes de quitar: la × está pegada al nombre. */
  confirmRemove: (fileName: string) => Promise<boolean>;
}

const key = new PluginKey("pdfCards");

/** Los enlaces a PDF adjuntos del documento: dónde acaban, y qué son. */
export function pdfLinks(doc: PMNode): { start: number; end: number; href: string; label: string }[] {
  const out: { start: number; end: number; href: string; label: string }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = node.marks.find((m) => m.type.name === "link");
    const href = link?.attrs.href as string | undefined;
    const label = node.text ?? "";
    if (href && isPdfAttachment(href, label)) out.push({ start: pos, end: pos + node.nodeSize, href, label });
  });
  return out;
}

/**
 * Quita el enlace que acaba donde está la tarjeta. Se busca al pulsar, con la
 * posición de ese momento, y no con la de cuando se pintó: la tarjeta se
 * reutiliza entre transacciones y para entonces el texto puede haberse movido.
 */
export function removeLinkBefore(view: EditorView, pos: number, href: string) {
  const before = view.state.doc.resolve(pos).nodeBefore;
  const link = before?.marks.find((m) => m.type.name === "link");
  if (!before || link?.attrs.href !== href) return;
  view.dispatch(view.state.tr.delete(pos - before.nodeSize, pos));
}

function build(doc: PMNode, { onOpen, confirmRemove }: PdfCardsOptions): DecorationSet {
  const decos = pdfLinks(doc).flatMap(({ start, end, href, label }) => [
    // El texto del enlace, escondido: en su lugar se ve la tarjeta.
    Decoration.inline(start, end, { class: "hidden" }),
    Decoration.widget(
      end,
      (view, getPos) => {
        const el = document.createElement("span") as HTMLElement & { _pdfRoot?: Root; _pdfGone?: boolean };
        el.className = "block";
        // Se monta **después**, no aquí: Tiptap crea el editor durante el
        // render de React, ProseMirror pinta esta decoración en ese momento, y
        // montar un árbol de React dentro de otro render está prohibido. Lo
        // hacía, y el DOM quedaba descolocado: al pulsar la tarjeta, React
        // fallaba con «NotFoundError: The object can not be found here.» (jose,
        // 6-oct-2026). Si ProseMirror la descartó antes, no se monta.
        queueMicrotask(() => {
          if (el._pdfGone) return;
          const root = createRoot(el);
          el._pdfRoot = root;
          root.render(
            <PdfCard
              url={href}
              fileName={label}
              onOpen={() => onOpen({ url: href, fileName: label })}
              onRemove={() => {
                void confirmRemove(label).then((ok) => {
                  // La posición, después de contestar: el texto pudo moverse.
                  const pos = getPos();
                  if (ok && pos !== undefined) removeLinkBefore(view, pos, href);
                });
              }}
            />,
          );
        });
        return el;
      },
      {
        side: 1,
        // La misma clave reutiliza la tarjeta entre transacciones: escribir en
        // la nota no vuelve a descargar ni a dibujar el PDF.
        key: `pdf:${href}:${label}`,
        ignoreSelection: true,
        stopEvent: () => true,
        destroy: (node) => {
          const el = node as HTMLElement & { _pdfRoot?: Root; _pdfGone?: boolean };
          el._pdfGone = true;
          // Fuera del render de ProseMirror: desmontar dentro de él avisa.
          const root = el._pdfRoot;
          if (root) queueMicrotask(() => root.unmount());
        },
      },
    ),
  ]);
  return DecorationSet.create(doc, decos);
}

export const PdfCards = Extension.create<PdfCardsOptions>({
  name: "pdfCards",
  addOptions() {
    return { onOpen: () => {}, confirmRemove: async () => true };
  },
  addProseMirrorPlugins() {
    const opts: PdfCardsOptions = {
      onOpen: (pdf) => this.options.onOpen(pdf),
      confirmRemove: (name) => this.options.confirmRemove(name),
    };
    return [
      new Plugin({
        key,
        state: {
          init: (_, state) => build(state.doc, opts),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc, opts) : old),
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
      }),
    ];
  },
});
