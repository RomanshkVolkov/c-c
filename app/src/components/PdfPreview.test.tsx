import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * El visor de PDF pinta las páginas a mano en su contenedor. Ahí dentro estaba
 * también el «Cargando…» de React: al vaciarlo para las páginas se llevaba ese
 * <p>, y React fallaba después al quitarlo («NotFoundError: The object can not
 * be found here.», 6-oct-2026). Mutante: los mensajes otra vez dentro del
 * contenedor de las páginas.
 */
const { openPdf } = vi.hoisted(() => {
  const page = {
    getViewport: () => ({ width: 100, height: 140 }),
    render: () => ({ promise: Promise.resolve() }),
  };
  const doc = { numPages: 2, getPage: async () => page };
  return { openPdf: vi.fn(async () => ({ promise: Promise.resolve(doc), destroy: async () => {} })) };
});
vi.mock("@/lib/pdf", () => ({ openPdf }));
vi.mock("@/lib/media", () => ({ openAttachment: vi.fn() }));

// jsdom no tiene contexto 2D ni IntersectionObserver: los dos, de pega.
HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
vi.stubGlobal(
  "IntersectionObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const { default: PdfPreview } = await import("./PdfPreview");

afterEach(cleanup);

describe("el visor de PDF", () => {
  it("pinta las páginas sin chocar con lo que pinta React", async () => {
    const errores = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PdfPreview url="/api/v1/notes/n/attachments/a/raw" fileName="informe.pdf" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll("canvas[data-page]").length).toBe(2));
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
    const choque = errores.mock.calls.some((c) => /NotFoundError|not a child/i.test(c.map(String).join(" ")));
    errores.mockRestore();
    expect(choque).toBe(false);
    expect(screen.getByText(/1 \/ 2/)).toBeTruthy();
  });
});
