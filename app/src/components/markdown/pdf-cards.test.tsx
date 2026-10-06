import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Un PDF adjunto se ve como tarjeta, en lectura (chat, comentarios, docs) y
 * en el editor (notas, descripciones); un enlace normal sigue siendo enlace. En
 * el editor la tarjeta no entra en lo que se guarda. Mutantes: tarjeta para
 * cualquier enlace; sin tarjeta en el editor; guardar la tarjeta en el texto.
 */
vi.mock("@/lib/api", () => ({ api: {}, apiUrl: (p: string) => `http://localhost${p}` }));
vi.mock("@/components/PdfCard", () => ({
  default: ({ fileName, onRemove }: { fileName: string; onRemove?: () => void }) => (
    <span data-pdf-card={fileName}>
      tarjeta{onRemove && <button onClick={onRemove}>quitar</button>}
    </span>
  ),
}));
const { default: Markdown } = await import("./Markdown");
const { default: MarkdownEditor } = await import("./MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

const MD = "mira [informe.pdf](/api/v1/notes/n/attachments/a/raw) y [ejemplo](https://ejemplo.com)";

describe("un PDF adjunto", () => {
  it("en lectura se ve como tarjeta, y un enlace normal no", () => {
    const { container } = render(<Markdown>{MD}</Markdown>);
    expect(container.querySelector('[data-pdf-card="informe.pdf"]')).toBeTruthy();
    expect(container.querySelectorAll("[data-pdf-card]").length).toBe(1);
    expect(container.querySelector('a[href="https://ejemplo.com"]')).toBeTruthy();
  });

  it("en el editor también, sin que la tarjeta se guarde", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptProvider>
        <MarkdownEditor value={MD} onChange={onChange} />
      </PromptProvider>,
    );
    await waitFor(() => expect(container.querySelector('[data-pdf-card="informe.pdf"]')).toBeTruthy());
    expect(container.querySelectorAll("[data-pdf-card]").length).toBe(1);
    for (const [md] of onChange.mock.calls) expect(String(md)).not.toContain("tarjeta");
  });
});

// En el editor el texto del enlace se esconde y sólo se ve la tarjeta; quitarla
// borra el enlace, que es lo que se guarda, después de preguntar (la × está
// pegada al nombre). Mutantes: no esconder el texto; la × que no borra; no
// preguntar; quitar aunque se cancele; en lectura, ofrecer quitar.
describe("la tarjeta en el editor", () => {
  it("esconde el texto del enlace y su × lo quita del documento, si se confirma", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ConfirmProvider>
        <PromptProvider>
          <MarkdownEditor value={MD} onChange={onChange} />
        </PromptProvider>
      </ConfirmProvider>,
    );
    const quitar = await waitFor(() => {
      const b = container.querySelector('[data-pdf-card="informe.pdf"] button');
      if (!b) throw new Error("sin tarjeta aún");
      return b;
    });
    const enlace = container.querySelector('.prose-editor a[href="/api/v1/notes/n/attachments/a/raw"]');
    expect(enlace?.querySelector(".hidden")?.textContent).toBe("informe.pdf");
    expect(container.querySelector('.prose-editor a[href="https://ejemplo.com"] .hidden')).toBeNull();

    // Cancelar no quita nada.
    fireEvent.click(quitar);
    fireEvent.click(await screen.findByRole("button", { name: /^(cancel|cancelar)$/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(quitar);
    fireEvent.click(await screen.findByRole("button", { name: /^(remove the pdf|quitar el pdf)$/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const guardado = String(onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]);
    expect(guardado).not.toContain("informe.pdf");
    expect(guardado).toContain("https://ejemplo.com");
  });

  it("en lectura no se ofrece quitar", () => {
    const { container } = render(<Markdown>{MD}</Markdown>);
    expect(container.querySelector('[data-pdf-card="informe.pdf"] button')).toBeNull();
  });
});

