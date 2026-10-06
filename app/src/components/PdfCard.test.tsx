import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Un PDF adjunto como tarjeta, al estilo de Slack (jose, 6-oct-2026): nombre,
 * «PDF» y la primera página; un clic abre el visor. Si la página no se puede
 * dibujar, la tarjeta sigue ahí y sigue abriendo. Mutantes: no dibujar la
 * primera página; no abrir al pulsar; romper la tarjeta si falla el PDF.
 */
const { openPdf, drawPage } = vi.hoisted(() => {
  const destroy = vi.fn(async () => {});
  return {
    destroy,
    openPdf: vi.fn(async () => ({ promise: Promise.resolve({ doc: true }), destroy })),
    drawPage: vi.fn(async (..._args: unknown[]) => {}),
  };
});
vi.mock("@/lib/pdf", () => ({ openPdf, drawPage }));
const { default: PdfCard } = await import("./PdfCard");

afterEach(() => {
  cleanup();
  openPdf.mockClear();
  drawPage.mockReset().mockResolvedValue(undefined);
});

describe("la tarjeta de un PDF", () => {
  it("dice qué es, dibuja su primera página y abre el visor", async () => {
    const onOpen = vi.fn();
    render(<PdfCard url="/api/v1/notes/n/attachments/a/raw" fileName="informe.pdf" onOpen={onOpen} />);
    expect(screen.getByText("informe.pdf")).toBeTruthy();
    expect(screen.getByText("PDF")).toBeTruthy();
    await waitFor(() => expect(drawPage).toHaveBeenCalled());
    expect(openPdf).toHaveBeenCalledWith("/api/v1/notes/n/attachments/a/raw");
    expect(drawPage.mock.calls[0][1]).toBe(1);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalled();
  });

  it("si la página no se puede dibujar, sigue ahí y sigue abriendo", async () => {
    drawPage.mockRejectedValueOnce(new Error("pdf roto"));
    const onOpen = vi.fn();
    render(<PdfCard url="/api/v1/x/raw" fileName="roto.pdf" onOpen={onOpen} />);
    await waitFor(() => expect(drawPage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalled();
    expect(screen.getByText("roto.pdf")).toBeTruthy();
  });
});
