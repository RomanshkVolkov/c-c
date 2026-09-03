import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The palette, and the two things it must not get wrong.
 *
 * It must not ask on every keystroke, and — the one that actually bites — a
 * slow early answer must never land on top of a later one. Typing "port" fires
 * four requests if you are unlucky with the debounce, and without a guard the
 * reply to "por" can arrive last and leave the list showing results for a query
 * nobody is looking at any more.
 */

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get } }));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: unknown) => unknown) => sel({ currentOrgId: "org-1" }),
}));

const { MemoryRouter } = await import("react-router-dom");
const { default: CommandPalette } = await import("@/components/CommandPalette");

const vacio = { tasks: [], notes: [], people: [], messages: [], dms: [] };

afterEach(() => {
  get.mockReset();
  cleanup();
});

const montar = () =>
  render(
    <MemoryRouter>
      <CommandPalette open onOpenChange={() => {}} />
    </MemoryRouter>,
  );

const escribir = (t: string) =>
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: t } });

describe("la paleta", () => {
  it("con la caja vacía ofrece qué hacer, no una lista vacía", () => {
    montar();
    expect(screen.getByText("New task")).toBeTruthy();
    expect(screen.getByText("New space")).toBeTruthy();
  });

  it("y las esconde en cuanto empiezas a buscar", async () => {
    get.mockResolvedValue({ success: true, data: vacio });
    montar();
    escribir("portento");
    // A partir de ahí buscas algo, y una lista de acciones estorba.
    await waitFor(() => expect(screen.queryByText("New task")).toBeNull());
  });

  it("no ofrece crear folder ni lista: ninguna de las dos sabe dónde iría", () => {
    montar();
    expect(screen.queryByText("New folder")).toBeNull();
    expect(screen.queryByText("New list")).toBeNull();
  });

  it("no molesta al servidor con una sola letra", async () => {
    montar();
    escribir("a");
    await new Promise((r) => setTimeout(r, 250));
    expect(get).not.toHaveBeenCalled();
  });

  it("busca acotada a la organización", async () => {
    get.mockResolvedValue({ success: true, data: vacio });
    montar();
    escribir("portento");
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(String(get.mock.calls[0][0])).toContain("orgId=org-1");
  });

  it("una respuesta vieja y lenta no pisa a la nueva", async () => {
    let resolverPrimera: (v: unknown) => void = () => {};
    get
      .mockImplementationOnce(() => new Promise((r) => { resolverPrimera = r; }))
      .mockResolvedValueOnce({
        success: true,
        data: { ...vacio, tasks: [{ kind: "task", id: "t2", title: "la nueva", link: "/tasks" }] },
      });

    montar();
    escribir("uno");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    escribir("dos");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await screen.findByText("la nueva");

    // Y ahora contesta la primera, tarde.
    resolverPrimera({
      success: true,
      data: { ...vacio, tasks: [{ kind: "task", id: "t1", title: "la vieja", link: "/tasks" }] },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("la vieja")).toBeNull();
    expect(screen.getByText("la nueva")).toBeTruthy();
  });

  it("enseña cada fuente por separado, no una lista revuelta", async () => {
    get.mockResolvedValue({
      success: true,
      data: {
        ...vacio,
        tasks: [{ kind: "task", id: "t", title: "una tarea", link: "/tasks" }],
        dms: [{ kind: "dm", id: "d", title: "un directo", link: "/dm" }],
      },
    });
    montar();
    escribir("algo");
    await screen.findByText("una tarea");
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByText("Direct messages")).toBeTruthy();
  });

  /**
   * Un servidor que no manda todas las categorías.
   *
   * La app se instala por su cuenta y el backend despliega por la suya, así que
   * siempre hay un rato en que una versión nueva habla con un servidor viejo.
   * Una categoría que falta deja un `undefined` donde se espera una lista, y lo
   * que se cae no es esa categoría: es la búsqueda entera.
   */
  it("una respuesta a la que le falta una categoría no tumba la paleta", async () => {
    get.mockResolvedValue({
      success: true,
      // Sin `docs`, como contestaría un backend anterior a esa categoría.
      data: { tasks: [{ kind: "task", id: "t", title: "sigue saliendo", link: "/tasks" }] },
    });
    montar();
    escribir("algo");
    expect(await screen.findByText("sigue saliendo")).toBeTruthy();
  });
});
