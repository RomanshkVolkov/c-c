import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { NodeRangeSelection } from "@tiptap/extension-node-range";

/**
 * Lo que salió al mirar las notas en el navegador (27-oct-2026), y que jsdom
 * sí puede comprobar.
 */
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");

afterEach(cleanup);

function ui(value: string) {
  return (
    <PromptProvider>
      <MarkdownEditor value={value} onChange={() => {}} blockTools placeholder="Escribe aquí" />
    </PromptProvider>
  );
}

async function editorOf(): Promise<Editor> {
  return waitFor(() => {
    const dom = document.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
    if (!dom?.editor) throw new Error("sin editor aún");
    return dom.editor;
  });
}

describe("el editor, mirado", () => {
  it("el «Escribe…» se va cuando el contenido llega de fuera (al volver a una nota)", async () => {
    const { rerender, queryByText } = render(ui(""));
    await editorOf();
    expect(queryByText("Escribe aquí")).not.toBeNull();
    rerender(ui("Ya hay texto"));
    await waitFor(() => expect(queryByText("Escribe aquí")).toBeNull());
  });

  it("los bloques que lleva el asa se marcan, para atenuarlos mientras se arrastran", async () => {
    render(ui("Uno\n\nDos\n\nTres"));
    const editor = await editorOf();
    const second = editor.state.doc.child(0).nodeSize;
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeRangeSelection.create(editor.state.doc, second + 1, second + 2)),
      );
    });
    await waitFor(() => {
      const marked = [...document.querySelectorAll(".prose-editor .ProseMirror-selectednoderange")];
      expect(marked.map((el) => el.textContent)).toEqual(["Dos"]);
    });
  });
});
