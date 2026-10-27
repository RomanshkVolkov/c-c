import { Extension } from "@tiptap/core";
import { getNodeRangeDecorations, isNodeRangeSelection } from "@tiptap/extension-node-range";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * Marca los bloques que lleva el asa de arrastrar.
 *
 * Al empezar a arrastrar, el asa selecciona sus bloques con una
 * `NodeRangeSelection`, y quien la pinta es la extensión `NodeRange`. No se
 * carga entera porque trae sus propios atajos (Mayúsculas+flechas, Ctrl+A,
 * seleccionar con el ratón) y cambiaría cómo se selecciona en todo editor;
 * de ella sólo hace falta la decoración, con su clase
 * `ProseMirror-selectednoderange`. El CSS la atenúa mientras se arrastra
 * (`[data-dragging]`, ver MarkdownEditor).
 */
export const DragSource = Extension.create({
  name: "dragSource",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("dragSource"),
        props: {
          decorations: (state) =>
            isNodeRangeSelection(state.selection) ? getNodeRangeDecorations([...state.selection.ranges]) : null,
        },
      }),
    ];
  },
});
