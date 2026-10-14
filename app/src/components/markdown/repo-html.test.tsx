import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * El HTML de un README: insignias en fila, un logo con su tamaño y un párrafo
 * centrado. Lo que los README de verdad escriben, y que se veía roto.
 * Mutantes: no pasar `width`; ampliar la imagen aunque esté en un enlace; el
 * párrafo sin sus atributos cuando hay includes.
 */

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() }, apiUrl: (p: string) => p }));
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<object>()), openExternal }));

const { default: Markdown } = await import("@/components/markdown/Markdown");

const README = `<p align="center">
  <a href="https://ci.example.com"><img src="https://img.shields.io/badge/ci-green.svg" alt="ci"></a>
  <img src="https://example.com/logo.png" alt="logo" width="120">
</p>`;

afterEach(cleanup);

describe("el HTML de un README", () => {
  it("un logo conserva su tamaño, y el párrafo, su alineación", () => {
    render(<Markdown allowHtml includes>{README}</Markdown>);
    const logo = screen.getByAltText("logo");
    expect(logo.getAttribute("width")).toBe("120");
    expect(logo.className).not.toContain("max-h-80");
    expect(logo.closest("p")?.getAttribute("align")).toBe("center");
  });

  it("una insignia en un enlace lleva al enlace, no se amplía", async () => {
    render(<Markdown allowHtml>{README}</Markdown>);
    fireEvent.click(screen.getByAltText("ci"));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://ci.example.com"));
    // Ampliada, la imagen saldría dos veces: en el texto y en la vista grande.
    expect(screen.getAllByAltText("ci")).toHaveLength(1);
  });
});
