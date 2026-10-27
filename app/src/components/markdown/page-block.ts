import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Bloque de página: un párrafo que no lleva más que un enlace a otra página de
 * la app se pinta como una fila de página (icono, sin subrayado), como en
 * Notion. Es lo que deja `/page`.
 *
 * Sólo es vista: en el documento sigue siendo un párrafo con un enlace, y en
 * el markdown `[Título](/notes/<id>)` en su línea. Lo leen igual el MCP, el
 * export y los backlinks, y un enlace en mitad de una frase sigue siendo un
 * enlace corriente.
 */

/** Las páginas de la app: una nota, o una página de la documentación. */
const PAGE_HREF = /^\/notes\/[^/?#]+$|^\/tasks\?(?:.*&)?page=/;

export function isPageHref(href: unknown): boolean {
  return typeof href === "string" && PAGE_HREF.test(href);
}

/** El enlace de página de un párrafo que no lleva nada más, o null. */
export function pageBlockHref(node: PMNode): string | null {
  if (node.type.name !== "paragraph" || node.childCount === 0) return null;
  let href: string | null = null;
  let only = true;
  node.forEach((child) => {
    const link = child.marks.find((m) => m.type.name === "link");
    const h = link?.attrs.href as string | undefined;
    if (!child.isText || !h || (href !== null && h !== href)) only = false;
    else href = h;
  });
  return only && isPageHref(href) ? href : null;
}

const KEY = new PluginKey("pageBlock");

function decorate(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph") return true;
    if (pageBlockHref(node)) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "page-block" }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export const PageBlock = Extension.create({
  name: "pageBlock",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: KEY,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: {
          decorations: (state) => KEY.getState(state),
        },
      }),
    ];
  },
});
