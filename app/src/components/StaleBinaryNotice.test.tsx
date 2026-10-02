import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Una ventana de una copia de cac que el actualizador ya borró lo dice, y se
 * reinicia con un botón. Ver el porqué en StaleBinaryNotice.tsx.
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { relaunch } = vi.hoisted(() => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

const { default: StaleBinaryNotice } = await import("./StaleBinaryNotice");

beforeEach(() => {
  invoke.mockReset();
  relaunch.mockReset();
});
afterEach(cleanup);

describe("una copia vieja de cac", () => {
  it("con el ejecutable en su sitio no dice nada", async () => {
    invoke.mockResolvedValue(false);
    render(<StaleBinaryNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("binary_replaced"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("si la actualizaron con la ventana abierta, lo dice al volver a ella y se reinicia con un botón", async () => {
    invoke.mockResolvedValue(false);
    render(<StaleBinaryNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    invoke.mockResolvedValue(true);
    fireEvent.focus(window);
    const aviso = await screen.findByRole("alert");
    expect(aviso.textContent).toMatch(/(se actualizó|was updated)/i);

    fireEvent.click(screen.getByRole("button", { name: /(reiniciar|restart)/i }));
    expect(relaunch).toHaveBeenCalled();
  });
});
