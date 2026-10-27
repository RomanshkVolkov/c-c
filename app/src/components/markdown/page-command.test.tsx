import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";

/**
 * `/page`, como en Notion (27-oct-2026): crea una subpágina de la nota y deja
 * su enlace **solo en su párrafo**, que se pinta como bloque de página. Un
 * enlace en mitad de una frase sigue siendo un enlace.
 */
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");
const { matching } = await import("@/components/markdown/slash-menu");

afterEach(cleanup);

function mount(value: string, props: { onCreatePage?: () => Promise<{ title: string; href: string; open?: () => void } | null>; onChange?: (md: string) => void } = {}) {
  render(
    <PromptProvider>
      <MarkdownEditor value={value} onChange={props.onChange ?? (() => {})} blockTools onCreatePage={props.onCreatePage} />
    </PromptProvider>,
  );
}

async function editorOf(): Promise<Editor> {
  return waitFor(() => {
    const dom = document.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
    if (!dom?.editor) throw new Error("sin editor aún");
    return dom.editor;
  });
}

/** Escribe `/page` al final del párrafo `n` (desde 1) y elige el comando. */
function runPage(editor: Editor, paragraphEnd: number) {
  editor.chain().setTextSelection(paragraphEnd).insertContent("/page").run();
  const to = editor.state.selection.from;
  const cmd = matching(editor, "page", editor.extensionManager.extensions.find((e) => e.name === "slashMenu")!.options)[0];
  expect(cmd.title).toBe("Page");
  cmd.run(editor, { from: to - 5, to }, editor.extensionManager.extensions.find((e) => e.name === "slashMenu")!.options);
}

describe("/page", () => {
  it("se encuentra también escrito en castellano y con acento", async () => {
    mount("Hola", { onCreatePage: async () => null });
    const editor = await editorOf();
    const options = editor.extensionManager.extensions.find((e) => e.name === "slashMenu")!.options;
    expect(matching(editor, "pági", options).map((c) => c.title)).toContain("Page");
  });

  it("no se ofrece si quien monta el editor no sabe crear páginas", async () => {
    mount("Hola");
    const editor = await editorOf();
    const options = editor.extensionManager.extensions.find((e) => e.name === "slashMenu")!.options;
    expect(matching(editor, "page", options).map((c) => c.title)).not.toContain("Page");
  });

  it("en una línea vacía, la línea pasa a ser el bloque de la página, y se entra en ella", async () => {
    const open = vi.fn();
    const onChange = vi.fn();
    mount("Intro\n\nFin", {
      onCreatePage: async () => ({ title: "Sin título", href: "/notes/n1", open }),
      onChange,
    });
    const editor = await editorOf();
    // Una línea vacía entre las dos: Intro, Enter.
    editor.chain().setTextSelection(6).splitBlock().run();
    const emptyAt = editor.state.selection.from;
    expect(editor.state.selection.$from.parent.content.size).toBe(0);
    runPage(editor, emptyAt);
    await waitFor(() => expect(open).toHaveBeenCalled());
    const md = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(md).toBe("Intro\n\n[Sin título](/notes/n1)\n\nFin");
    // Sin un hueco donde estaba la línea: el markdown no lo diría (una línea
    // vacía no se guarda), pero en pantalla se ve.
    expect(editor.state.doc.childCount).toBe(3);
    await waitFor(() => expect(document.querySelectorAll(".prose-editor p.page-block")).toHaveLength(1));
  });

  it("con texto en la línea, el bloque va en la siguiente y el texto se queda", async () => {
    const onChange = vi.fn();
    mount("Intro", { onCreatePage: async () => ({ title: "Hija", href: "/notes/n2" }), onChange });
    const editor = await editorOf();
    runPage(editor, 6);
    await waitFor(() => expect(onChange.mock.calls.some((c) => (c[0] as string).includes("/notes/n2"))).toBe(true));
    const md = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(md).toBe("Intro\n\n[Hija](/notes/n2)");
  });

  it("si no se pudo crear, no deja nada", async () => {
    const onChange = vi.fn();
    mount("Intro", { onCreatePage: async () => null, onChange });
    const editor = await editorOf();
    runPage(editor, 6);
    await new Promise((r) => setTimeout(r, 20));
    expect(editor.getText()).toBe("Intro");
  });
});

describe("el bloque de página", () => {
  it("es un enlace a una página solo en su línea; en mitad de una frase, o hacia fuera, no", async () => {
    mount(
      "[Hija](/notes/n1)\n\nVer [Hija](/notes/n1) antes\n\n[Fuera](https://ejemplo.com)\n\n[Doc](/tasks?doc=d&page=p)",
    );
    await editorOf();
    await waitFor(() => {
      const blocks = [...document.querySelectorAll(".prose-editor p.page-block")].map((p) => p.textContent);
      expect(blocks).toEqual(["Hija", "Doc"]);
    });
  });
});
