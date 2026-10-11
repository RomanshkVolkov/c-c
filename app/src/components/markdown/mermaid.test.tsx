import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * Un bloque ```mermaid se dibuja como diagrama (9-oct-2026: hasta entonces se
 * veía el código). Mermaid de verdad no se puede dibujar en jsdom —no hay
 * medidas de SVG—, así que aquí va uno de mentira que apunta con qué se le
 * llamó: lo que se prueba es lo nuestro (qué bloque va a diagrama, en modo
 * estricto, con el tema de la app, y qué se ve si falla).
 */

const { render: dibujar, initialize } = vi.hoisted(() => ({
  render: vi.fn(),
  initialize: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: { initialize, render: dibujar } }));

const { default: Markdown, mermaidSource } = await import("@/components/markdown/Markdown");
const { useThemeStore } = await import("@/store/theme.store");

const MD = "Antes\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n```ts\nconst x = 1;\n```";

beforeEach(() => {
  dibujar.mockReset();
  initialize.mockReset();
  dibujar.mockResolvedValue({ svg: '<svg data-dibujado="si"><text>A</text></svg>' });
  useThemeStore.setState({ resolved: "dark" });
});
afterEach(cleanup);

describe("un bloque mermaid", () => {
  it("se dibuja como diagrama, con su texto tal cual", async () => {
    const { container } = render(<Markdown>{MD}</Markdown>);
    await waitFor(() => expect(container.querySelector('[data-mermaid="diagram"] svg[data-dibujado="si"]')).not.toBeNull());
    expect(dibujar.mock.calls[0][1]).toBe("graph TD\n  A-->B");
  });

  it("los demás bloques de código siguen siendo código", async () => {
    const { container } = render(<Markdown>{MD}</Markdown>);
    await waitFor(() => expect(container.querySelector('[data-mermaid="diagram"]')).not.toBeNull());
    expect(container.querySelector("pre code.language-ts")?.textContent).toContain("const x = 1;");
    expect(dibujar).toHaveBeenCalledTimes(1);
  });

  // El texto lo escribió cualquiera: modo estricto, que limpia etiquetas y no
  // deja enlaces ni clics que ejecuten código.
  it("en modo estricto y con el tema de la app", async () => {
    render(<Markdown>{MD}</Markdown>);
    await waitFor(() => expect(initialize).toHaveBeenCalled());
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", theme: "dark", startOnLoad: false }));
    useThemeStore.setState({ resolved: "light" });
    await waitFor(() => expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" })));
  });

  it("si tiene un error, se ve el código y qué falló, no un hueco", async () => {
    dibujar.mockRejectedValue(new Error("Parse error on line 2:\n...A-->"));
    const { container } = render(<Markdown>{MD}</Markdown>);
    const aviso = await waitFor(() => {
      const el = container.querySelector('[data-mermaid="error"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(aviso.textContent).toContain("The diagram has an error:");
    expect(aviso.textContent).toContain("Parse error on line 2:");
    expect(aviso.querySelector("code")?.textContent).toContain("A-->B");
  });

  // Las notas pasan el HTML por un saneador: el bloque tiene que seguir
  // reconociéndose como mermaid ahí también.
  it("también en una nota, con el HTML saneado", async () => {
    const { container } = render(<Markdown allowHtml>{MD}</Markdown>);
    await waitFor(() => expect(container.querySelector('[data-mermaid="diagram"]')).not.toBeNull());
  });
});

describe("reconocer un bloque mermaid", () => {
  const pre = (className: unknown, value = "graph TD\n") => ({
    children: [{ tagName: "code", properties: { className }, children: [{ value }] }],
  });

  it("por la clase del lenguaje, en lista o en texto", () => {
    expect(mermaidSource(pre(["language-mermaid"]))).toBe("graph TD");
    expect(mermaidSource(pre("language-mermaid"))).toBe("graph TD");
  });

  it("otro lenguaje, o sin clase, no", () => {
    expect(mermaidSource(pre(["language-ts"]))).toBeNull();
    expect(mermaidSource(pre(undefined))).toBeNull();
    expect(mermaidSource(undefined)).toBeNull();
  });
});
