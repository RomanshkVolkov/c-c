import { useEffect, useState } from "react";
import CodeBlock from "@tiptap/extension-code-block";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type ReactNodeViewProps,
} from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Code2 } from "lucide-react";

import { useT } from "@/lib/i18n";
import MermaidDiagram from "./MermaidDiagram";

/**
 * Bloques de código del editor, con los ```mermaid dibujados.
 *
 * Hasta el 27-oct-2026 el diagrama sólo se veía en el visor de lectura
 * (`Markdown.tsx`), y las notas no tienen modo lectura: están siempre en el
 * editor. Un diagrama migrado de Notion se veía como el código que lo
 * describe.
 *
 * Un bloque mermaid enseña el diagrama, y el código **sólo mientras el cursor
 * está dentro**: se entra con un clic en el diagrama o con las flechas, igual
 * que en cualquier otro bloque. El markdown guardado no cambia: el nodo sigue
 * siendo `codeBlock` con `language: "mermaid"`, y tiptap-markdown lo escribe
 * como siempre.
 *
 * El SVG va en su propio `div` (lo pinta `MermaidDiagram`), hermano del
 * contenido editable y nunca dentro: un contenedor que se llena a mano no
 * puede tener hijos que gestione otro (ver `PdfPreview.test.tsx`).
 */

/** Lo que tarda el diagrama en seguir al código mientras se escribe. */
const REDRAW_DELAY_MS = 300;

function MermaidBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const { t } = useT();
  // Si el cursor está dentro de este bloque. Por suscripción y no leído en el
  // render: una vista de nodo no se repinta cuando sólo cambia la selección.
  const editing = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) return false;
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (typeof pos !== "number") return false;
      const { from, to } = ed.state.selection;
      return from > pos && to < pos + node.nodeSize;
    },
  });

  // Mientras se escribe, el diagrama espera a que se pare un momento: dibujar
  // en cada tecla parpadea, y casi todas las intermedias son un error.
  const source = node.textContent;
  const [drawn, setDrawn] = useState(source);
  useEffect(() => {
    if (source === drawn) return;
    const timer = setTimeout(() => setDrawn(source), REDRAW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source, drawn]);

  // Vacío no hay nada que dibujar: el código, para poder escribirlo.
  const showCode = editing || !source.trim();

  const enter = () => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (typeof pos === "number") editor.chain().focus().setTextSelection(pos + 1).run();
  };

  return (
    <NodeViewWrapper className="mermaid-block group/mermaid relative" data-editing={showCode ? "" : undefined}>
      <div contentEditable={false} className="relative">
        {drawn.trim() ? (
          <div onClick={enter} className="cursor-pointer">
            <MermaidDiagram source={drawn} />
          </div>
        ) : null}
        {!showCode && (
          <button
            type="button"
            onClick={enter}
            className="motion-press absolute right-2 top-2 flex items-center gap-1 rounded border bg-background/90 px-1.5 py-0.5
                       text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground
                       focus-visible:opacity-100 group-hover/mermaid:opacity-100"
          >
            <Code2 className="size-3" />
            {t("common:editor.editDiagram")}
          </button>
        )}
      </div>
      {/* El código se oculta con CSS y no se desmonta: ProseMirror necesita el
          contenido en el DOM para poder meter el cursor con las flechas. */}
      <pre className={showCode ? "" : "sr-only"} data-mermaid-source="">
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

const isMermaid = (node: PMNode) => node.attrs.language === "mermaid";

/**
 * React sólo para los mermaid. Un bloque de código corriente es un `<pre>` de
 * siempre: montarle a cada uno un árbol de React costaba en una nota larga y
 * llenaba la consola de avisos de `flushSync` al cargarla. Cada vista se rehace
 * si el lenguaje cambia de bando (escribir «mermaid» en uno que no lo era).
 */
export const DiagramCodeBlock = CodeBlock.extend({
  addNodeView() {
    const mermaid = ReactNodeViewRenderer(MermaidBlockView, {
      update: ({ newNode, updateProps }) => {
        if (!isMermaid(newNode)) return false;
        updateProps();
        return true;
      },
    });
    return (props) => {
      if (isMermaid(props.node)) return mermaid(props);
      const dom = document.createElement("pre");
      const code = document.createElement("code");
      const language = props.node.attrs.language as string | null;
      if (language) code.className = `language-${language}`;
      dom.appendChild(code);
      return {
        dom,
        contentDOM: code,
        // Otro lenguaje, otra vista: el `class` del `<code>` y, si pasa a
        // mermaid, la de React.
        update: (node: PMNode) => node.type === props.node.type && node.attrs.language === language,
      };
    };
  },
});
