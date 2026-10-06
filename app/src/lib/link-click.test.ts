import { describe, expect, it, vi } from "vitest";

/**
 * Un clic en un enlace del editor (notas, descripciones). Un PDF adjunto en
 * una nota no se veía: al pulsarlo, la ventana seguía la ruta relativa del
 * adjunto, recargaba la app y acababa en el resumen (jose, 6-oct-2026). Y el
 * modo lectura tampoco reconocía un PDF cuya URL acaba en `/raw`.
 * Mutantes: pedir Ctrl para un adjunto; mandar el PDF fuera; abrir un enlace
 * normal sin Ctrl; reconocer el PDF sólo por la URL.
 */
vi.mock("@/lib/api", () => ({ apiUrl: (p: string) => `https://cac.example${p}` }));
const { linkClickAction, isPdfAttachment } = await import("./media");

const PDF = "/api/v1/notes/n1/attachments/a1/raw";

describe("un clic en un enlace del editor", () => {
  it("un PDF adjunto se ve en la app, con un clic normal", () => {
    expect(linkClickAction(PDF, "informe.pdf", false)).toBe("preview-pdf");
    expect(linkClickAction(PDF, "informe.pdf", true)).toBe("preview-pdf");
  });

  it("otro adjunto se abre con su programa, con un clic normal", () => {
    expect(linkClickAction(PDF, "hoja.xlsx", false)).toBe("open-file");
  });

  it("un enlace normal pone el cursor; con Ctrl se abre", () => {
    expect(linkClickAction("https://ejemplo.com", "ejemplo", false)).toBe("edit");
    expect(linkClickAction("https://ejemplo.com", "ejemplo", true)).toBe("follow");
  });

  it("un PDF se reconoce por su nombre aunque la URL acabe en /raw, y por la URL", () => {
    expect(isPdfAttachment(PDF, "informe.pdf")).toBe(true);
    expect(isPdfAttachment("/api/v1/tasks/t1/attachments/a/informe.pdf", "ver")).toBe(true);
    expect(isPdfAttachment(PDF, "informe.pdf.zip")).toBe(false);
    expect(isPdfAttachment("https://ejemplo.com/x.pdf", "x.pdf")).toBe(false);
  });
});
