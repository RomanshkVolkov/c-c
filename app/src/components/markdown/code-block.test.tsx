import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

/**
 * Un ```mermaid se dibuja también dentro del editor (27-oct-2026): las notas no
 * tienen modo lectura, y un diagrama se veía como su código. Mermaid va de
 * mentira por lo mismo que en `mermaid.test.tsx`: jsdom no mide SVG.
 */

const { render: draw } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: draw } }));
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));

const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");

const MD = "Antes\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n```ts\nconst x = 1;\n```";

beforeEach(() => {
  draw.mockReset();
  draw.mockResolvedValue({ svg: '<svg data-drawn="yes"></svg>' });
});
afterEach(cleanup);

function mount(value: string, onChange: (md: string) => void = () => {}) {
  return render(
    <PromptProvider>
      <MarkdownEditor value={value} onChange={onChange} />
    </PromptProvider>,
  );
}

describe("un bloque mermaid en el editor", () => {
  it("se dibuja, con su texto tal cual", async () => {
    const { container } = mount(MD);
    await waitFor(() =>
      expect(container.querySelector('[data-mermaid="diagram"] svg[data-drawn="yes"]')).not.toBeNull(),
    );
    expect(draw.mock.calls[0][1]).toBe("graph TD\n  A-->B");
  });

  it("los demás bloques de código siguen siendo código", async () => {
    const { container } = mount(MD);
    await waitFor(() => expect(container.querySelector('[data-mermaid="diagram"]')).not.toBeNull());
    expect(container.querySelectorAll('[data-mermaid="diagram"]')).toHaveLength(1);
    const plain = [...container.querySelectorAll(".prose-editor pre")].find((p) =>
      p.textContent?.includes("const x = 1;"),
    );
    expect(plain).toBeDefined();
    expect(plain?.className).not.toContain("sr-only");
  });

  it("el código sólo se ve con el cursor dentro, y un clic en el diagrama lo mete", async () => {
    const { container } = mount(MD);
    const diagram = await waitFor(() => {
      const el = container.querySelector('[data-mermaid="diagram"]');
      if (!el) throw new Error("sin diagrama aún");
      return el as HTMLElement;
    });
    const source = container.querySelector("[data-mermaid-source]")!;
    expect(source.className).toContain("sr-only");
    fireEvent.click(diagram);
    await waitFor(() => expect(source.className).not.toContain("sr-only"));
  });

  it("el markdown guardado no cambia", async () => {
    const onChange = vi.fn();
    const { container } = mount(MD, onChange);
    await waitFor(() => expect(container.querySelector('[data-mermaid="diagram"]')).not.toBeNull());
    // Una edición fuera del bloque obliga a serializar el documento entero.
    const p = container.querySelector(".prose-editor p");
    p!.textContent = "Antes!";
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const md = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(md).toContain("```mermaid\ngraph TD\n  A-->B\n```");
    expect(md).toContain("```ts\nconst x = 1;\n```");
  });
});
