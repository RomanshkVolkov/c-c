import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Todo» tiene que ser todo.
 *
 * El servidor, si no le dicen de dónde salió una tarea, deja fuera lo que entró
 * por un canal de cliente. Eso convertía la lente **All** en «todo menos los
 * clientes»: una lista con siete tareas abiertas salía como «0 visible», y no
 * había nada en pantalla que lo explicara. Lo mismo con «asignadas a mí», que
 * se callaba un ticket asignado a mí por haberlo levantado un cliente.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post: vi.fn(), delete: vi.fn() } }));

const { useMyWorkStore } = await import("@/store/mywork.store");

beforeEach(() => {
  get.mockClear();
  get.mockResolvedValue({ success: true, data: [] });
});

const urlDe = async (lens: string) => {
  useMyWorkStore.setState({ lens: lens as never });
  await useMyWorkStore.getState().load("org-1");
  const llamadas = get.mock.calls;
  return String(llamadas[llamadas.length - 1][0]);
};

describe("las lentes de Mi trabajo", () => {
  it("«todo» pide de verdad todo", async () => {
    expect(await urlDe("all")).toContain("origin=any");
  });

  it("«asignadas a mí» no descarta un ticket de cliente que es mío", async () => {
    const url = await urlDe("assigned");
    expect(url).toContain("assignee=me");
    expect(url).toContain("origin=any");
  });

  it("las otras dos preguntas por persona, igual", async () => {
    expect(await urlDe("created")).toContain("origin=any");
    expect(await urlDe("watching")).toContain("origin=any");
  });

  it("y la de clientes sigue siendo sólo de clientes", async () => {
    const url = await urlDe("clients");
    expect(url).toContain("origin=clients");
    expect(url).not.toContain("origin=any");
  });
});
