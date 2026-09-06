import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Un enlace tiene que parecer un enlace en los dos sitios.
 *
 * Tailwind desnuda los `<a>` a propósito, así que vestirlos es responsabilidad
 * de quien los pinta — y estaba hecha en un solo lado. El mensaje enviado los
 * viste componente a componente en `Markdown.tsx`; el compositor no los vestía
 * nadie. Escribías una URL, el editor la reconocía y la convertía en enlace de
 * verdad, y en pantalla seguía siendo texto plano: no había forma de saber si
 * había enganchado hasta después de enviar.
 *
 * Los dos lados se comprueban aquí juntos porque el fallo es justamente que
 * divergieron.
 */

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/media", () => ({
  attachmentPath: () => null,
  mediaSrc: (s: string) => s,
  openAttachment: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const Markdown = (await import("@/components/markdown/Markdown")).default;
const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");

const TEXTO = "mira esto https://ejemplo.com/algo y dime";

describe("una url en un mensaje", () => {
  it("el mensaje enviado la convierte en enlace", () => {
    render(<Markdown>{TEXTO}</Markdown>);
    expect(screen.getByRole("link")).toHaveProperty("href", "https://ejemplo.com/algo");
  });

  // Que el compositor la reconozca es lo que hace que el fallo sea invisible:
  // el enlace **existe**, sólo que no se veía.
  it("el compositor también, mientras se escribe", async () => {
    render(
      <PromptProvider>
        <MarkdownEditor value={TEXTO} onChange={() => {}} />
      </PromptProvider>,
    );
    await waitFor(() => expect(document.querySelector(".prose-editor a")).toBeTruthy());
  });

  /**
   * Y la hoja de estilos los viste en los dos.
   *
   * Se lee el CSS porque jsdom no aplica Tailwind: aquí no hay forma de
   * comprobar el color computado, y lo que se rompió no fue el marcado —el `<a>`
   * estaba— sino que nadie le daba aspecto de enlace.
   */
  it("y la hoja de estilos los viste en los dos sitios", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    const regla = css.match(/\.md-body a[^{]*\{[^}]*\}/)?.[0] ?? "";
    expect(regla).toMatch(/\.prose-editor a/);
    expect(regla).toMatch(/underline/);
  });
});
