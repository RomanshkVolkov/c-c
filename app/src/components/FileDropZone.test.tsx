import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * La zona para soltar de una conversación (como WhatsApp Web, jose,
 * 6-oct-2026). Mutantes: enseñarla con un texto; no entregar los ficheros; no
 * leer las rutas; dejar que el drop llegue también al editor de debajo (dos
 * subidas); no irse al salir.
 */
const { readDropped, error } = vi.hoisted(() => ({
  readDropped: vi.fn(async (uris: string[]) => uris.map((u) => new File(["x"], u.split("/").pop()!, { type: "image/png" }))),
  error: vi.fn(),
}));
vi.mock("@/lib/dropped", async (orig) => ({ ...(await orig<typeof import("@/lib/dropped")>()), readDropped }));
vi.mock("@/lib/platform", () => ({ isTauri: true, isWebBuild: false }));
vi.mock("sonner", () => ({ toast: { error } }));
const { default: FileDropZone } = await import("./FileDropZone");

afterEach(() => {
  cleanup();
  error.mockClear();
});

const transfer = (o: { types: string[]; files?: File[]; html?: string }) => ({
  types: o.types,
  files: o.files ?? [],
  items: [],
  dropEffect: "none",
  getData: (t: string) => (t === "text/html" ? (o.html ?? "") : ""),
});

function montar() {
  const onFiles = vi.fn();
  const debajo = vi.fn();
  render(
    <FileDropZone onFiles={onFiles}>
      <div data-testid="conversacion" onDrop={debajo}>
        mensajes
      </div>
    </FileDropZone>,
  );
  return { onFiles, debajo, zona: screen.getByTestId("conversacion") };
}

describe("soltar en una conversación", () => {
  it("con un fichero aparece la zona; con un texto, no", () => {
    const { zona } = montar();
    fireEvent.dragEnter(zona, { dataTransfer: transfer({ types: ["text/plain"] }) });
    expect(document.querySelector("[data-drop-zone]")).toBeNull();
    fireEvent.dragEnter(zona, { dataTransfer: transfer({ types: ["Files"] }) });
    expect(document.querySelector("[data-drop-zone]")).toBeTruthy();
    fireEvent.dragLeave(zona);
    expect(document.querySelector("[data-drop-zone]")).toBeNull();
  });

  it("entrega los ficheros, y el de debajo no los recibe también", async () => {
    const { onFiles, debajo, zona } = montar();
    const f = new File(["x"], "captura.png", { type: "image/png" });
    fireEvent.dragEnter(zona, { dataTransfer: transfer({ types: ["Files"], files: [f] }) });
    fireEvent.drop(zona, { dataTransfer: transfer({ types: ["Files"], files: [f] }) });
    await waitFor(() => expect(onFiles).toHaveBeenCalledWith([f]));
    expect(debajo).not.toHaveBeenCalled();
    expect(document.querySelector("[data-drop-zone]")).toBeNull();
  });

  it("si sólo llega la ruta (Thunar), la lee y la entrega", async () => {
    const { onFiles, zona } = montar();
    const html = "<a>file:///home/rv/Pictures/logo.png</a>";
    fireEvent.dragEnter(zona, { dataTransfer: transfer({ types: ["text/uri-list", "text/html"], html }) });
    fireEvent.drop(zona, { dataTransfer: transfer({ types: ["text/uri-list", "text/html"], html }) });
    await waitFor(() => expect(onFiles).toHaveBeenCalled());
    expect(readDropped).toHaveBeenCalledWith(["file:///home/rv/Pictures/logo.png"]);
    expect(onFiles.mock.calls[0][0][0].name).toBe("logo.png");
  });
});
