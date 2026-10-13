import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MODULES } = await import("@/lib/nav");
const { PANELS } = await import("@/components/sidebar/panels");

/**
 * Un módulo nuevo es una entrada en `MODULES` y un panel en `PANELS`. Las dos
 * listas viven en sitios distintos a propósito (ver `lib/nav.ts`), y esto es
 * lo que impide que un icono del riel abra un panel que no existe. Mutante:
 * quitar una entrada de cualquiera de las dos.
 */
describe("el registro de módulos", () => {
  it("cada módulo tiene su panel, y cada panel su módulo", () => {
    expect(Object.keys(PANELS).sort()).toEqual(MODULES.map((m) => m.key).sort());
  });
});
