import { afterEach, describe, expect, it, vi } from "vitest";
import { installPauseWhenHidden } from "@/lib/pause-hidden";

describe("con la ventana oculta", () => {
  let undo = () => {};
  afterEach(() => {
    undo();
    vi.restoreAllMocks();
    document.documentElement.classList.remove("app-hidden");
  });

  it("marca la página para pausar las animaciones, y la desmarca al volver", () => {
    const state = vi.spyOn(document, "visibilityState", "get");
    state.mockReturnValue("visible");
    undo = installPauseWhenHidden();
    expect(document.documentElement.classList.contains("app-hidden")).toBe(false);
    state.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.documentElement.classList.contains("app-hidden")).toBe(true);
    state.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.documentElement.classList.contains("app-hidden")).toBe(false);
  });
});
