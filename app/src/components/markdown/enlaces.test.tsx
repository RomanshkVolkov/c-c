import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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

/**
 * Una cita que apunta a un adjunto borrado.
 *
 * Es lo que queda del fallo aunque se arregle el borrado: los textos que ya
 * tienen un enlace muerto de antes siguen ahí, y ningún arreglo del borrado los
 * repara. Un icono roto no dice qué falta, ni que faltaba a propósito, ni que
 * alguien lo quitó — y donde se ve es en un reporte, que es lo que alguien lee
 * meses después.
 */
describe("una imagen que ya no está", () => {
  it("se lee, en vez de salir como un icono roto", async () => {
    render(<Markdown>{"antes\n\n![captura del error](/api/v1/tasks/t1/attachments/x/raw)\n\ndespués"}</Markdown>);
    const img = document.querySelector("img");
    expect(img).toBeTruthy();
    // El navegador de la prueba no carga nada, así que el fallo se provoca.
    await act(async () => {
      img!.dispatchEvent(new Event("error"));
    });
    expect(document.querySelector("img")).toBeNull();
    // Y con el texto alternativo dentro: es la única pista de qué se perdió.
    expect(screen.getByText(/captura del error/)).toBeTruthy();
  });
});

/**
 * Una tabla no es prosa, y no se le aplica la medida de lectura.
 *
 * Estaba puesta en el cuerpo entero: una tabla de cincuenta variables tenía que
 * caber en 68 caracteres, las columnas se estrujaban, y `overflow-wrap:
 * anywhere` las hacía «caber» partiendo las palabras a mitad — «Almac/enami/
 * ento». Como siempre lograba caber, su propio deslizamiento no se activaba
 * nunca. El editor no tenía el problema, así que escribir y leer enseñaban dos
 * cosas distintas.
 *
 * Se lee el CSS porque jsdom no aplica Tailwind ni calcula anchos: aquí no hay
 * forma de medir una columna. Lo que se puede fijar es que la regla no vuelva a
 * abarcar la tabla, que es de donde venía todo.
 */
describe("la medida de lectura de un documento", () => {
  const css = () => readFileSync(resolve(__dirname, "../../index.css"), "utf8");

  it("no se le aplica al cuerpo entero", () => {
    const regla = css().match(/\.prose-doc \.md-body \{[^}]*\}/)?.[0] ?? "";
    expect(regla).not.toMatch(/max-w-\[68ch\]/);
  });

  it("sino sólo a lo que se lee de corrido", () => {
    const regla = css().match(/\.prose-doc \.md-body > :where\([^)]*\)[^{]*\{[^}]*\}/)?.[0] ?? "";
    expect(regla).toMatch(/max-w-\[68ch\]/);
    // Una tabla y un bloque de código usan el ancho del panel.
    expect(regla).not.toMatch(/table|pre/);
  });

  // Con las palabras partidas la tabla siempre cabía, así que su deslizamiento
  // no llegaba a activarse: el síntoma era texto destrozado, no una barra.
  it("y en una celda las palabras no se parten", () => {
    const regla = css().match(/\.md-body th, \.md-body td \{[^}]*\}/)?.[0] ?? "";
    expect(regla).toMatch(/overflow-wrap:\s*normal/);
  });
});
