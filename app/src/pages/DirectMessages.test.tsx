import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Un enlace a un directo tiene que ser un enlace.
 *
 * No lo era: el buscador mandaba a `/dm?c=<id>` al encontrar un mensaje y a
 * `/dm` al encontrar una persona, y esta pantalla **no leía la dirección**. Las
 * dos cosas aterrizaban en la lista pelada — «no me lleva más que a direct
 * chats», que fue como se reportó.
 *
 * Son dos preguntas distintas y por eso dos parámetros: `?c=` sabe qué hilo
 * quiere, `?u=` sabe con quién y deja que la pantalla lo encuentre o lo cree.
 */

const { open, openWith } = vi.hoisted(() => ({ open: vi.fn(), openWith: vi.fn() }));

vi.mock("@/store/dm.store", () => ({
  useDMStore: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) => {
      const s = { conversationId: null, open, openWith };
      return sel ? sel(s) : s;
    },
    { setState: vi.fn() },
  ),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ currentOrgId: "org-1" }),
}));
vi.mock("@/components/DMSwitcher", () => ({ default: () => null }));
vi.mock("@/components/DMThread", () => ({ default: () => null }));

const { default: DirectMessages } = await import("./DirectMessages");

// Dentro de `StrictMode`, como corre la app de verdad (`main.tsx`). Importa:
// en desarrollo React invoca cada efecto **dos veces** a propósito, y sin la
// memoria de «esto ya se pidió» eso son dos peticiones por cada enlace abierto.
const en = (url: string) =>
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[url]}>
        <DirectMessages />
      </MemoryRouter>
    </StrictMode>,
  );

// Rearmados aquí: `restoreMocks: true` deja los `vi.fn()` sin implementación
// antes de cada test, así que un `mockResolvedValue` puesto arriba no llega.
beforeEach(() => {
  open.mockResolvedValue(undefined);
  openWith.mockResolvedValue("conv-1");
});
afterEach(cleanup);

describe("llegar a un directo por su dirección", () => {
  it("`?c=` abre esa conversación", async () => {
    en("/dm?c=conv-7");
    await waitFor(() => expect(open).toHaveBeenCalledWith("conv-7"));
    expect(openWith).not.toHaveBeenCalled();
  });

  it("`?u=` abre la conversación con esa persona, exista o no", async () => {
    en("/dm?u=u-bea");
    // Crear el hilo es parte de la respuesta: quien enlaza a una persona tiene
    // un nombre, no un hilo, y no puede saber si ya hablasteis.
    await waitFor(() => expect(openWith).toHaveBeenCalledWith("org-1", "u-bea"));
    expect(open).not.toHaveBeenCalled();
  });

  it("sin parámetros no abre nada", async () => {
    en("/dm");
    await waitFor(() => expect(open).not.toHaveBeenCalled());
    expect(openWith).not.toHaveBeenCalled();
  });

  it("pide la conversación una sola vez, no una por repintado", async () => {
    en("/dm?c=conv-7");
    await waitFor(() => expect(open).toHaveBeenCalled());
    // React monta los efectos dos veces en desarrollo. Sin memoria, cada
    // enlace abierto serían dos peticiones — y en el caso que falla, donde la
    // dirección no se limpia, cada repintado una más.
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("y un enlace muerto no se convierte en una tormenta de peticiones", async () => {
    open.mockRejectedValue(new Error("404"));
    en("/dm?c=conv-borrada");
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(open).toHaveBeenCalledTimes(1);
  });
});
