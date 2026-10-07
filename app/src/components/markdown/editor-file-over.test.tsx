import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

/**
 * En tareas y notas no hay zona para soltar de toda la pantalla: se resalta el
 * recuadro sobre el que pasa el fichero, y se apaga al soltar en cualquier
 * parte. Sin subida posible, no se resalta. Mutantes: resaltar con un texto;
 * resaltar sin poder subir; no apagarse al soltar fuera.
 */
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
const { default: MarkdownEditor } = await import("./MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");

const montar = async (onUpload?: () => Promise<null>) => {
  const { container } = render(
    <PromptProvider>
      <MarkdownEditor value="hola" onChange={() => {}} onUpload={onUpload} />
    </PromptProvider>,
  );
  await waitFor(() => {
    if (!container.querySelector(".ProseMirror")) throw new Error("sin editor");
  });
  return container.firstElementChild as HTMLElement;
};
const con = (...types: string[]) => ({ dataTransfer: { types, dropEffect: "none" } });

describe("resaltar el recuadro al pasar un fichero", () => {
  it("con un fichero se resalta, y se apaga al soltar en cualquier parte", async () => {
    const caja = await montar(async () => null);
    fireEvent.dragEnter(caja, con("text/plain"));
    expect(caja.hasAttribute("data-file-over")).toBe(false);
    fireEvent.dragEnter(caja, con("Files"));
    expect(caja.hasAttribute("data-file-over")).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("drop"));
    });
    expect(caja.hasAttribute("data-file-over")).toBe(false);
  });

  it("sin subida posible, no se resalta", async () => {
    const caja = await montar();
    fireEvent.dragEnter(caja, con("Files"));
    expect(caja.hasAttribute("data-file-over")).toBe(false);
  });
});
