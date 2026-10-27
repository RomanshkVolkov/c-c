import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Plegar una sección por su encabezado, con la flechita del asa (27-oct-2026).
 *
 * Se pliega todo lo que hay debajo de un encabezado hasta el siguiente del
 * mismo nivel o mayor, como en Notion u Obsidian. Es **sólo de vista**, como
 * los colapsables con `persist: false`: el plegado vive en el estado de un
 * plugin, no en el documento, así que no cambia el markdown, no dispara el
 * autoguardado y una nota se abre siempre desplegada.
 *
 * Sólo encabezados del nivel superior del documento: uno dentro de una lista o
 * de un colapsable no tiene «lo de debajo» que plegar.
 */

const KEY = new PluginKey<FoldState>("headingFold");

interface FoldState {
  /** Posiciones de los encabezados plegados, mapeadas con cada cambio. */
  folded: number[];
  decorations: DecorationSet;
}

/** Desde dónde hasta dónde llega lo que pliega el encabezado en `pos`. */
function foldedRange(doc: PMNode, pos: number): { from: number; to: number } | null {
  const heading = doc.nodeAt(pos);
  if (!heading || heading.type.name !== "heading") return null;
  const level = heading.attrs.level as number;
  const from = pos + heading.nodeSize;
  let to = doc.content.size;
  let found = false;
  doc.forEach((node, offset) => {
    if (found || offset < from) return;
    if (node.type.name === "heading" && (node.attrs.level as number) <= level) {
      to = offset;
      found = true;
    }
  });
  // Sólo líneas vacías debajo (el editor deja una al final) no es nada que
  // plegar.
  let empty = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock && node.content.size === 0) return false;
    if (node.isBlock && !node.isTextblock && !node.isLeaf) return true;
    empty = false;
    return false;
  });
  return from < to && !empty ? { from, to } : null;
}

function isTopLevelHeading(doc: PMNode, pos: number): boolean {
  if (pos < 0 || pos > doc.content.size) return false;
  const $pos = doc.resolve(pos);
  return $pos.depth === 0 && doc.nodeAt(pos)?.type.name === "heading";
}

function build(doc: PMNode, folded: number[]): DecorationSet {
  const decos: Decoration[] = [];
  for (const pos of folded) {
    const heading = doc.nodeAt(pos);
    const range = foldedRange(doc, pos);
    if (!heading || !range) continue;
    decos.push(Decoration.node(pos, pos + heading.nodeSize, { class: "is-folded" }));
    doc.forEach((node, offset) => {
      if (offset >= range.from && offset < range.to) {
        decos.push(Decoration.node(offset, offset + node.nodeSize, { class: "is-folded-away" }));
      }
    });
  }
  return DecorationSet.create(doc, decos);
}

/** El cursor no puede quedarse dentro de algo oculto: lo que lo contiene se despliega. */
function unfoldAround(state: EditorState, folded: number[]): number[] {
  const at = state.selection.from;
  return folded.filter((pos) => {
    const range = foldedRange(state.doc, pos);
    return !range || at < range.from || at > range.to;
  });
}

export function isHeadingFolded(state: EditorState, pos: number): boolean {
  return KEY.getState(state)?.folded.includes(pos) ?? false;
}

/**
 * Pliega o despliega el encabezado en `pos`. No hace nada si no lo es.
 *
 * Al plegar, el cursor sube al final del encabezado: si se quedara dentro de
 * lo plegado, la siguiente tecla escribiría en algo que no se ve (y lo
 * desplegaría).
 */
export function toggleHeadingFold(editor: Editor, pos: number) {
  const { state } = editor;
  const heading = state.doc.nodeAt(pos);
  if (!heading || !isTopLevelHeading(state.doc, pos)) return;
  const tr = state.tr.setMeta(KEY, { toggle: pos });
  const range = foldedRange(state.doc, pos);
  const at = state.selection.from;
  if (!isHeadingFolded(state, pos) && range && at >= range.from && at <= range.to) {
    tr.setSelection(TextSelection.create(state.doc, pos + heading.nodeSize - 1));
  }
  editor.view.dispatch(tr);
}

/** Si un encabezado tiene algo debajo que plegar. */
export function canFold(doc: PMNode, pos: number): boolean {
  return isTopLevelHeading(doc, pos) && foldedRange(doc, pos) !== null;
}

export const HeadingFold = Extension.create({
  name: "headingFold",

  addProseMirrorPlugins() {
    return [
      new Plugin<FoldState>({
        key: KEY,
        state: {
          init: (_, state) => ({ folded: [], decorations: DecorationSet.create(state.doc, []) }),
          apply: (tr, old, _oldState, newState) => {
            const meta = tr.getMeta(KEY) as { toggle?: number } | undefined;
            let folded = old.folded;
            if (tr.docChanged) {
              folded = folded
                .map((pos) => tr.mapping.mapResult(pos))
                .filter((r) => !r.deleted)
                .map((r) => r.pos)
                .filter((pos) => isTopLevelHeading(tr.doc, pos));
            }
            if (meta?.toggle !== undefined) {
              folded = folded.includes(meta.toggle)
                ? folded.filter((p) => p !== meta.toggle)
                : [...folded, meta.toggle];
            } else if (folded.length > 0 && (tr.docChanged || tr.selectionSet)) {
              folded = unfoldAround(newState, folded);
            }
            if (folded === old.folded && !tr.docChanged) return old;
            return { folded, decorations: build(tr.doc, folded) };
          },
        },
        props: {
          decorations: (state) => KEY.getState(state)?.decorations,
        },
      }),
    ];
  },
});
