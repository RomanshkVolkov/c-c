import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

/**
 * Un enlace del editor nunca lo sigue la ventana. Llevan `target="_blank"`, y
 * el clic de un PDF adjunto en una nota abría el navegador del sistema en el
 * resumen de la app en vez del visor (jose, 6-oct-2026). Qué hace el clic lo
 * decide `linkClickAction` (ver link-click.test.ts). Mutante: no cancelar el
 * `click`.
 */
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");

describe("un enlace en el editor", () => {
  it.each([
    ["un adjunto", "[informe.pdf](/api/v1/notes/n/attachments/a/raw)"],
    ["uno de fuera", "[ejemplo](https://ejemplo.com)"],
  ])("%s no se sigue en la ventana", async (_, md) => {
    render(
      <PromptProvider>
        <MarkdownEditor value={md} onChange={() => {}} />
      </PromptProvider>,
    );
    const a = await waitFor(() => {
      const el = document.querySelector(".prose-editor a");
      if (!el) throw new Error("sin enlace aún");
      return el;
    });
    const seguido = fireEvent.click(a);
    expect(seguido).toBe(false);
  });
});
