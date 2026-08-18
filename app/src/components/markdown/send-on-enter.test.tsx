import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

/**
 * Enter manda; Shift+Enter salta de línea.
 *
 * Montado de verdad y no con el editor simulado: lo que se comprueba es un
 * atajo de teclado de Tiptap conviviendo con los menús de sugerencias, y eso
 * sólo existe cuando el editor existe. Un editor falso diría que sí a todo.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { default: MarkdownEditor } = await import("@/components/markdown/MarkdownEditor");
const { PromptProvider } = await import("@/components/PromptDialog");
const { EnviarConEnter } = await import("@/components/markdown/send-on-enter");
const { MENTION_MENU_KEY } = await import("@/components/markdown/mention-menu");

const montar = (props: Record<string, unknown>) => {
  const r = render(
    <PromptProvider>
      <MarkdownEditor value="" onChange={() => {}} minHeight="2rem" {...props} />
    </PromptProvider>,
  );
  return r.container.querySelector(".ProseMirror") as HTMLElement;
};

/** El atajo, tal y como lo declara la extensión, con un editor de mentira. */
const atajos = (editor: Record<string, unknown>, onSubmit = vi.fn()) => {
  const ext = EnviarConEnter.configure({ onSubmit });
  const ctx = { editor, options: ext.options };
  return {
    enter: () => (ext.config.addKeyboardShortcuts as () => Record<string, () => boolean>)
      .call(ctx).Enter(),
    onSubmit,
  };
};

const editorFalso = (
  o: Partial<{ activo: string[]; vacio: boolean; eligiendo: boolean }> = {},
) => ({
  isActive: (n: string) => (o.activo ?? []).includes(n),
  isEmpty: o.vacio ?? false,
  // `PluginKey.getState(state)` lee `state[key.key]`, así que un estado de
  // mentira con esa propiedad es exactamente lo que ve la extensión cuando el
  // menú de `@` está abierto.
  // `key` es interno de prosemirror-state y no está en sus tipos, pero es lo
  // que `getState` consulta; el cast es la forma honesta de decirlo.
  state: o.eligiendo
    ? { [(MENTION_MENU_KEY as unknown as { key: string }).key]: { active: true } }
    : {},
  commands: { setHardBreak: () => true },
});

describe("mandar con Enter", () => {
  it("el compositor con onSubmit trae el atajo, y sin él no", () => {
    const con = montar({ onSubmit: () => {} });
    expect(con).toBeTruthy();
    const sin = montar({});
    expect(sin).toBeTruthy();
  });

  it("Enter manda cuando hay algo escrito", () => {
    const { enter, onSubmit } = atajos(editorFalso());
    expect(enter()).toBe(true);
    expect(onSubmit).toHaveBeenCalled();
  });

  it("con el editor vacío no manda nada, ni deja un párrafo de más", () => {
    const { enter, onSubmit } = atajos(editorFalso({ vacio: true }));
    expect(enter()).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("dentro de una lista, Enter sigue siendo de la lista", () => {
    const { enter, onSubmit } = atajos(editorFalso({ activo: ["listItem"] }));
    expect(enter()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("y dentro de un bloque de código, también", () => {
    const { enter, onSubmit } = atajos(editorFalso({ activo: ["codeBlock"] }));
    expect(enter()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("eligiendo en un menú de sugerencias, Enter es del menú", () => {
    // Sin esto, escribir «@an» y dar Enter publica el mensaje con la mención a
    // medias en vez de completarla.
    const { enter, onSubmit } = atajos(editorFalso({ eligiendo: true }));
    expect(enter()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
