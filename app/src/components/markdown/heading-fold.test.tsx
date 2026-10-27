import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";

/**
 * Plegar una sección por su encabezado, con la flechita (27-oct-2026). Sólo de
 * vista: no toca el markdown ni dispara el autoguardado.
 */
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");
const { toggleHeadingFold, canFold, isHeadingFolded } = await import("@/components/markdown/heading-fold");

afterEach(cleanup);

const MD = "## Uno\n\nA\n\n### Uno.1\n\nB\n\n## Dos\n\nC";

async function mount(onChange: (md: string) => void = () => {}): Promise<Editor> {
  render(
    <PromptProvider>
      <MarkdownEditor value={MD} onChange={onChange} blockTools />
    </PromptProvider>,
  );
  return waitFor(() => {
    const dom = document.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
    if (!dom?.editor) throw new Error("sin editor aún");
    return dom.editor;
  });
}

/** Posición del encabezado de nivel superior cuyo texto es `text`. */
function headingAt(editor: Editor, text: string): number {
  let at = -1;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "heading" && node.textContent === text) at = offset;
  });
  return at;
}

const hidden = () => [...document.querySelectorAll(".prose-editor .is-folded-away")].map((el) => el.textContent);

describe("plegar por encabezado", () => {
  it("oculta hasta el siguiente encabezado de su nivel o mayor, subsecciones incluidas", async () => {
    const editor = await mount();
    toggleHeadingFold(editor, headingAt(editor, "Uno"));
    await waitFor(() => expect(hidden()).toEqual(["A", "Uno.1", "B"]));
    expect(document.querySelector(".prose-editor .is-folded")?.textContent).toBe("Uno");
  });

  it("uno de nivel menor sólo pliega lo suyo", async () => {
    const editor = await mount();
    toggleHeadingFold(editor, headingAt(editor, "Uno.1"));
    await waitFor(() => expect(hidden()).toEqual(["B"]));
  });

  it("se despliega con la misma flechita", async () => {
    const editor = await mount();
    const pos = headingAt(editor, "Dos");
    toggleHeadingFold(editor, pos);
    expect(isHeadingFolded(editor.state, pos)).toBe(true);
    toggleHeadingFold(editor, pos);
    expect(isHeadingFolded(editor.state, pos)).toBe(false);
    await waitFor(() => expect(hidden()).toEqual([]));
  });

  it("no cambia el documento: ni markdown ni autoguardado", async () => {
    const onChange = vi.fn();
    const editor = await mount(onChange);
    toggleHeadingFold(editor, headingAt(editor, "Uno"));
    await waitFor(() => expect(hidden().length).toBeGreaterThan(0));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("si el cursor estaba dentro, sube al encabezado; y si vuelve a entrar, se despliega", async () => {
    const editor = await mount();
    const pos = headingAt(editor, "Uno");
    // El cursor en «A».
    editor.commands.setTextSelection(pos + editor.state.doc.nodeAt(pos)!.nodeSize + 1);
    toggleHeadingFold(editor, pos);
    expect(isHeadingFolded(editor.state, pos)).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe("Uno");
    // Con el teclado, otra vez dentro de lo plegado.
    editor.commands.setTextSelection(pos + editor.state.doc.nodeAt(pos)!.nodeSize + 1);
    expect(isHeadingFolded(editor.state, pos)).toBe(false);
  });

  it("sigue a su encabezado cuando cambia el texto de encima", async () => {
    const editor = await mount();
    toggleHeadingFold(editor, headingAt(editor, "Dos"));
    editor.chain().insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "Antes" }] }).run();
    expect(isHeadingFolded(editor.state, headingAt(editor, "Dos"))).toBe(true);
    await waitFor(() => expect(hidden()).toEqual(["C"]));
  });

  it("un encabezado sin nada debajo no ofrece plegar, y un párrafo tampoco", async () => {
    const editor = await mount();
    editor.chain().insertContentAt(editor.state.doc.content.size, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Fin" }] }).run();
    expect(canFold(editor.state.doc, headingAt(editor, "Fin"))).toBe(false);
    // Una imagen sola sí es algo que plegar, aunque no lleve texto.
    editor.chain().insertContentAt(editor.state.doc.content.size, [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Foto" }] },
      { type: "image", attrs: { src: "/api/v1/notes/n/attachments/a/raw" } },
    ]).run();
    expect(canFold(editor.state.doc, headingAt(editor, "Foto"))).toBe(true);
    expect(canFold(editor.state.doc, headingAt(editor, "Uno"))).toBe(true);
    expect(canFold(editor.state.doc, headingAt(editor, "Uno") + editor.state.doc.nodeAt(0)!.nodeSize)).toBe(false);
  });
});
