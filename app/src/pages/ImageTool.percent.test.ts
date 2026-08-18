import { describe, expect, it, vi } from "vitest";

/**
 * Compressing an image and getting a bigger file back is the one thing this
 * tool has to be honest about, and it was the case it garbled.
 *
 * The helper returned a percentage that was already negative when the file
 * grew, and the row drew a `+` in front of it — so a file 12% larger reported
 * "+-12.0%". Unsigned magnitude here; the caller owns the sign.
 */

// Importada, no replicada: un test que copia la función comprueba su propia
// copia y deja que la pantalla se aparte de la regla sin que nadie se entere.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: vi.fn() }));

const { reductionPercent } = await import("@/pages/ImageTool");

describe("el porcentaje del compresor", () => {
  it("dice cuánto encogió", () => {
    expect(reductionPercent(1000, 250)).toBe("75.0%");
  });

  it("y cuánto creció, sin signo pegado", () => {
    // Sin el valor absoluto esto era "-12.0%", y la fila lo pintaba "+-12.0%".
    expect(reductionPercent(100, 112)).toBe("12.0%");
    expect(reductionPercent(100, 112)).not.toContain("-");
  });

  it("no divide por cero", () => {
    expect(reductionPercent(0, 10)).toBe("0%");
  });
});
