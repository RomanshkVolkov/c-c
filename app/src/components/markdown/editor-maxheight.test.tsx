import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

/**
 * Un compositor de mensajes no crece sin fin: una captura pegada en un directo
 * ocupaba la pantalla entera y echaba fuera la conversación (jose,
 * 6-oct-2026). Con `maxHeight`, el editor hace scroll dentro y las imágenes se
 * ven en miniatura; sin él (notas), crece como siempre. Mutantes: no aplicar
 * el tope; aplicarlo siempre; quitar la regla de las imágenes.
 */
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
const { default: MarkdownEditor } = await import("./MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");

const caja = async (maxHeight?: string) => {
  const { container } = render(
    <PromptProvider>
      <MarkdownEditor value="hola" onChange={() => {}} maxHeight={maxHeight} />
    </PromptProvider>,
  );
  return waitFor(() => {
    const pm = container.querySelector(".ProseMirror");
    if (!pm) throw new Error("sin editor");
    return pm.closest(".px-3") as HTMLElement;
  });
};

describe("el alto del editor", () => {
  it("un compositor tiene tope y hace scroll dentro", async () => {
    const el = await caja("40vh");
    expect(el.style.maxHeight).toBe("40vh");
    expect(el.className).toContain("overflow-y-auto");
    expect(el.hasAttribute("data-compact")).toBe(true);
  });

  it("una nota crece con lo que lleva", async () => {
    const el = await caja();
    expect(el.style.maxHeight).toBe("");
    expect(el.hasAttribute("data-compact")).toBe(false);
  });

  it("y en un compositor las imágenes se ven en miniatura", () => {
    const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
    const regla = css.match(/\[data-compact\] \.ProseMirror img\s*\{[^}]*\}/)?.[0] ?? "";
    expect(regla).toMatch(/max-height:\s*10rem/);
  });
});
