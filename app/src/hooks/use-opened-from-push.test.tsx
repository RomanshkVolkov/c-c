import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

/**
 * Abrir la app pulsando un aviso del teléfono marca esa fila leída, y el
 * parámetro desaparece de la dirección (recargar no vuelve a marcar, y la
 * pantalla ve su enlace limpio). Mutantes: no marcar; no quitar el parámetro;
 * quitar también los demás parámetros (la tarea que había que abrir).
 */

const { markRead } = vi.hoisted(() => ({ markRead: vi.fn(async () => {}) }));
vi.mock("@/store/inbox.store", () => ({ useInboxStore: { getState: () => ({ markRead }) } }));

const { useOpenedFromPush } = await import("./use-opened-from-push");

let visto = "";
function Probe() {
  useOpenedFromPush();
  const l = useLocation();
  visto = l.pathname + l.search;
  return null;
}

describe("abrir desde un aviso del teléfono", () => {
  it("marca esa fila leída y deja la dirección como la de la campana", () => {
    render(
      <MemoryRouter initialEntries={["/tasks?task=it-1&notif=n-1"]}>
        <Probe />
      </MemoryRouter>,
    );
    expect(markRead).toHaveBeenCalledWith(["n-1"]);
    expect(visto).toBe("/tasks?task=it-1");
  });

  it("sin el parámetro no toca nada", () => {
    markRead.mockClear();
    render(
      <MemoryRouter initialEntries={["/chat?space=s"]}>
        <Probe />
      </MemoryRouter>,
    );
    expect(markRead).not.toHaveBeenCalled();
    expect(visto).toBe("/chat?space=s");
  });
});
