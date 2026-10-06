import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Un PDF de una lista de adjuntos (tarea, doc): la tarjeta y, al pulsarla, el
 * visor de la app. En los docs iba al programa del sistema. Mutante: no abrir
 * el visor.
 */
vi.mock("@/components/PdfCard", () => ({
  default: ({ fileName, onOpen }: { fileName: string; onOpen: () => void }) => (
    <button onClick={onOpen}>{fileName}</button>
  ),
}));
vi.mock("@/components/PdfPreview", () => ({ default: ({ fileName }: { fileName: string }) => <div>visor de {fileName}</div> }));
const { default: PdfAttachment, isPdfFile } = await import("./PdfAttachment");

afterEach(cleanup);

describe("un PDF en una lista de adjuntos", () => {
  it("abre el visor de la app", () => {
    render(<PdfAttachment url="/api/v1/docs/d/attachments/a/raw" fileName="acta.pdf" />);
    expect(screen.queryByText("visor de acta.pdf")).toBeNull();
    fireEvent.click(screen.getByText("acta.pdf"));
    expect(screen.getByText("visor de acta.pdf")).toBeTruthy();
  });

  it("se reconoce por el nombre", () => {
    expect(isPdfFile("Acta.PDF")).toBe(true);
    expect(isPdfFile("acta.pdf.zip")).toBe(false);
  });
});
