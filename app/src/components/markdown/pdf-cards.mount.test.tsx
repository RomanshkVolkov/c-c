import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

/**
 * Tiptap crea el editor durante el render de React, y la tarjeta del PDF
 * montaba su árbol de React ahí mismo: React avisaba y el DOM quedaba
 * descolocado (al pulsarla, «NotFoundError: The object can not be found
 * here.», jose, 6-oct-2026). En un fichero aparte porque React da ese aviso una
 * sola vez por módulo: otra prueba anterior lo gastaría. Mutante: montarla en
 * el momento.
 */
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
vi.mock("@/components/PdfCard", () => ({ default: () => <span data-pdf-card="x">tarjeta</span> }));

describe("montar el editor con un PDF", () => {
  it("no monta React dentro del render de otro", async () => {
    const errores = vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: MarkdownEditor } = await import("./MarkdownEditor");
    const { PromptProvider } = await import("@/components/PromptDialog");
    const { container } = render(
      <PromptProvider>
        <MarkdownEditor value="[informe.pdf](/api/v1/notes/n/attachments/a/raw)" onChange={() => {}} />
      </PromptProvider>,
    );
    await waitFor(() => expect(container.querySelector("[data-pdf-card]")).toBeTruthy());
    const anidado = errores.mock.calls.some((c) => String(c[0]).includes("Render methods should be a pure function"));
    errores.mockRestore();
    expect(anidado).toBe(false);
  });
});
