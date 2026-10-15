import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

/**
 * Mudarse con la llamada te lleva a la pantalla de la reunión y lo dice: verte
 * de pronto en otra sala, sin una palabra, parecería un fallo.
 * Mutantes: no navegar; no avisar; no limpiar (te devolvería allí cada vez).
 */
const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

const { default: FollowMove } = await import("./FollowMove");
const { useVoice } = await import("@/store/voice.store");

afterEach(cleanup);

function Donde() {
  return <span data-testid="donde">{useLocation().pathname}</span>;
}

describe("seguir la mudanza", () => {
  it("lleva a la reunión, lo dice, y no se queda pendiente", () => {
    const r = render(
      <MemoryRouter initialEntries={["/chat"]}>
        <FollowMove />
        <Routes>
          <Route path="*" element={<Donde />} />
        </Routes>
      </MemoryRouter>,
    );
    act(() => useVoice.setState({ mudanza: { inviteId: "inv-1", title: "Con el cliente" } }));
    expect(r.getByTestId("donde").textContent).toBe("/call/inv-1");
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Con el cliente"));
    expect(useVoice.getState().mudanza).toBeNull();
  });
});
