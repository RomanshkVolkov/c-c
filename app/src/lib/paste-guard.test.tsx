import { afterEach, describe, expect, it, vi } from "vitest";

import { installPasteGuard, shouldBlockPaste } from "@/lib/paste-guard";

/**
 * Una imagen pegada en un campo de texto se para antes de que el navegador
 * intente meterla. Mutantes: parar también lo que trae texto; parar en un
 * editor (`contenteditable`); no cancelar el pegado.
 */
const files = (n: number, text = "") =>
  ({ files: { length: n }, getData: (t: string) => (t === "text/plain" ? text : "") }) as unknown as DataTransfer;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pegar una imagen en un campo de texto", () => {
  it("se para en un input o un textarea, y no si trae texto", () => {
    const input = document.createElement("input");
    const area = document.createElement("textarea");
    expect(shouldBlockPaste(input, files(1))).toBe(true);
    expect(shouldBlockPaste(area, files(1))).toBe(true);
    // Una imagen copiada de una web trae su dirección: eso sí se pega.
    expect(shouldBlockPaste(input, files(1, "https://x.y/a.png"))).toBe(false);
    expect(shouldBlockPaste(input, files(0, "hola"))).toBe(false);
  });

  it("un editor sí sabe qué hacer con una imagen", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    expect(shouldBlockPaste(editor, files(1))).toBe(false);
  });

  // Un campo dentro de un editor (el de un enlace, por ejemplo) es del editor.
  it("un campo dentro de un editor tampoco se toca", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const inner = document.createElement("input");
    editor.appendChild(inner);
    expect(shouldBlockPaste(inner, files(1))).toBe(false);
  });

  // Fuera de un campo de texto no hay nada que el navegador intente meter.
  it("pegar sobre lo que no es un campo de texto no se toca", () => {
    expect(shouldBlockPaste(document.createElement("div"), files(1))).toBe(false);
  });

  it("instalada, cancela el pegado y avisa", () => {
    const blocked = vi.fn();
    const remove = installPasteGuard(blocked);
    const input = document.createElement("input");
    document.body.appendChild(input);
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: files(1) });
    expect(input.dispatchEvent(e)).toBe(false);
    expect(blocked).toHaveBeenCalledTimes(1);
    remove();
  });
});

// jose, 16-oct-2026: «ojito, en canales y chats tenemos el evento de pegar
// imágenes». Con la guarda puesta, el editor de markdown de un canal sigue
// recibiendo la imagen pegada y la sube. Mutante: parar también dentro de un
// editor.
describe("el editor de un canal sigue pegando imágenes", () => {
  it("con la guarda puesta, la imagen pegada se sube", async () => {
    const { render, cleanup } = await import("@testing-library/react");
    const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
    const { PromptProvider } = await import("@/components/PromptDialog");
    const remove = installPasteGuard(() => {});
    const onUpload = vi.fn(async () => ({ url: "/x.png", fileName: "captura.png" }));
    const r = render(
      <PromptProvider>
        <MarkdownEditor value="" onChange={() => {}} onUpload={onUpload} />
      </PromptProvider>,
    );
    const editor = await vi.waitFor(() => {
      const el = r.container.querySelector(".ProseMirror");
      if (!el) throw new Error("sin editor");
      return el as HTMLElement;
    });
    const file = new File(["x"], "captura.png", { type: "image/png" });
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", {
      value: {
        files: Object.assign([file], { item: () => file }),
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        types: ["Files"],
        getData: () => "",
      },
    });
    editor.dispatchEvent(e);
    await vi.waitFor(() => expect(onUpload).toHaveBeenCalled());
    remove();
    cleanup();
  });
});
