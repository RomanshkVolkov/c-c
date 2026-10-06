import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Salir en la web (barrido, 6-oct-2026). Un navegador puede ser de varios: al
 * salir no queda nada de la persona. Mutantes: borrar antes de dar de baja el
 * push (la baja va sin token); no recargar; borrar también tema e idioma;
 * dejar las notas o la sesión.
 */

const orden: string[] = [];
const { disablePush, revokeSession } = vi.hoisted(() => ({
  disablePush: vi.fn(async () => {
    orden.push(`push con token ${localStorage.getItem("access_token") ?? "—"}`);
    return "off";
  }),
  revokeSession: vi.fn(async () => {
    orden.push("refresh");
  }),
}));
vi.mock("@/lib/push", () => ({ disablePush }));
vi.mock("@/lib/api", () => ({ revokeSession }));

const { leaveWeb } = await import("./leave-web");

beforeEach(() => {
  orden.length = 0;
  localStorage.clear();
  for (const k of ["access_token", "cac-auth", "cac-notes", "cac-notifications", "cac-mywork", "cac-push-active", "cac-theme", "cac-locale", "otra-cosa"]) {
    localStorage.setItem(k, "x");
  }
});

describe("salir en la web", () => {
  it("da de baja con el token puesto, olvida lo de la persona y recarga", async () => {
    const reload = vi.fn(() => orden.push("recarga"));
    await leaveWeb("r-1", reload);
    expect(orden).toEqual(["push con token x", "refresh", "recarga"]);
    expect(revokeSession).toHaveBeenCalledWith("r-1");
    const quedan = Object.keys(localStorage).sort();
    expect(quedan).toEqual(["cac-locale", "cac-theme", "otra-cosa"]);
  });

  it("un servidor que no contesta no deja a nadie dentro", async () => {
    vi.useFakeTimers();
    disablePush.mockImplementationOnce(() => new Promise(() => {}));
    const reload = vi.fn();
    const p = leaveWeb("r-1", reload);
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(reload).toHaveBeenCalled();
    expect(localStorage.getItem("cac-auth")).toBeNull();
    vi.useRealTimers();
  });
});
