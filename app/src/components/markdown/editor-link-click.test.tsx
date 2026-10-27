import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";

/**
 * Un enlace del editor nunca lo sigue la ventana. Llevan `target="_blank"`, y
 * el clic de un PDF adjunto en una nota abría el navegador del sistema en el
 * resumen de la app en vez del visor (jose, 6-oct-2026). Qué hace el clic lo
 * decide `linkClickAction` (ver link-click.test.ts). Mutante: no cancelar el
 * `click`.
 *
 * Y desde el 27-oct-2026 un clic **abre** el enlace, como en Notion: con
 * Ctrl+clic jose no lo encontraba. Editarlo va por la burbuja.
 */
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<object>()), openExternal }));
const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");

afterEach(() => {
  cleanup();
  openExternal.mockReset();
});

function mount(md: string, props: { onLinkClick?: (href: string) => boolean | void; onChange?: (md: string) => void } = {}) {
  render(
    <PromptProvider>
      <MarkdownEditor value={md} onChange={props.onChange ?? (() => {})} onLinkClick={props.onLinkClick} />
    </PromptProvider>,
  );
}

async function link(): Promise<HTMLAnchorElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLAnchorElement>(".prose-editor a");
    if (!el) throw new Error("sin enlace aún");
    return el;
  });
}

/**
 * Un clic como lo ve ProseMirror. jsdom no sabe en qué posición cae un ratón,
 * así que se llama a `handleClick` del editor directamente, con el enlace como
 * destino; es lo que hace ProseMirror al soltar el botón.
 */
function pmClick(a: HTMLAnchorElement, init: MouseEventInit = {}) {
  const dom = document.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
  const view = dom.editor.view;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: a });
  const pos = view.posAtDOM(a, 0);
  return view.someProp("handleClick", (f) => f(view, pos, event)) ?? false;
}

describe("un enlace en el editor", () => {
  it.each([
    ["un adjunto", "[informe.pdf](/api/v1/notes/n/attachments/a/raw)"],
    ["uno de fuera", "[ejemplo](https://ejemplo.com)"],
  ])("%s no se sigue en la ventana", async (_, md) => {
    mount(md);
    const seguido = fireEvent.click(await link());
    expect(seguido).toBe(false);
  });

  it("uno de fuera se abre en el navegador con un clic normal", async () => {
    mount("[ejemplo](https://ejemplo.com)");
    expect(pmClick(await link())).toBe(true);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://ejemplo.com"));
  });

  it("uno a otra página se lo queda quien lo reclama, y no sale al navegador", async () => {
    const onLinkClick = vi.fn(() => true);
    mount("[Otra nota](/notes/abc)", { onLinkClick });
    pmClick(await link());
    expect(onLinkClick).toHaveBeenCalledWith("/notes/abc");
    await new Promise((r) => setTimeout(r, 20));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("uno relativo que nadie reclama no va a ningún sitio", async () => {
    mount("[algo](/tasks?doc=1)", { onLinkClick: () => false });
    pmClick(await link());
    await new Promise((r) => setTimeout(r, 20));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("con Mayúsculas el clic es de editar: no abre", async () => {
    mount("[ejemplo](https://ejemplo.com)");
    expect(pmClick(await link(), { shiftKey: true })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("al pasar por encima sale la burbuja, y «Quitar» deja el texto sin enlace", async () => {
    const onChange = vi.fn();
    mount("Ver [ejemplo](https://ejemplo.com) aquí", { onChange });
    const a = await link();
    act(() => {
      a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const bubble = await waitFor(() => {
      const el = document.querySelector("[data-link-bubble]");
      if (!el) throw new Error("sin burbuja");
      return el;
    });
    const remove = bubble.querySelector<HTMLButtonElement>('button[aria-label="Quitar"], button[aria-label="Remove"]')!;
    act(() => remove.click());
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const md = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(md).toBe("Ver ejemplo aquí");
  });

  it("con el cursor en un enlace, la burbuja sale sólo si se llegó con el teclado", async () => {
    mount("Ver [ejemplo](https://ejemplo.com) aquí");
    const a = await link();
    const dom = document.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    const editor = dom.editor;
    // Puesto por el programa (al cargar, al volver a la nota): nada.
    act(() => {
      editor.chain().focus().setTextSelection(editor.view.posAtDOM(a, 0) + 2).run();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector("[data-link-bubble]")).toBeNull();
    // Con las flechas: sí.
    act(() => {
      dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      editor.commands.setTextSelection(editor.view.posAtDOM(a, 0) + 3);
    });
    await waitFor(() => expect(document.querySelector("[data-link-bubble]")).not.toBeNull());
  });

  it("«Editar» de la burbuja cambia la URL del enlace entero", async () => {
    const onChange = vi.fn();
    mount("Ver [ejemplo](https://ejemplo.com) aquí", { onChange });
    const a = await link();
    act(() => {
      a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const edit = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>(
        '[data-link-bubble] button[aria-label="Editar el enlace"], [data-link-bubble] button[aria-label="Edit link"]',
      );
      if (!el) throw new Error("sin burbuja");
      return el;
    });
    act(() => edit.click());
    const input = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('[role="dialog"] input');
      if (!el) throw new Error("sin diálogo");
      return el;
    });
    fireEvent.change(input, { target: { value: "https://otro.com" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]).toBe("Ver [ejemplo](https://otro.com) aquí"),
    );
  });
});
