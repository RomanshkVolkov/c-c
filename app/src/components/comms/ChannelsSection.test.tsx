import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SpaceTree } from "@/types/task";

/**
 * Los canales del panel de Comunicación.
 *
 * Lo que se fija es lo que decide la lista, no el pintado: la sala general
 * arriba y separada; la fila marcada es **la que pinta la página** (la misma
 * `resolveSpace`); los no leídos y la voz por fila; pulsar navega a
 * `/chat?space=`; el filtro; y que abrir la sala general es del admin.
 * Mutantes: quitar el anclaje de la general; marcar `?space= ?? general` sin
 * mirar lo recordado; no navegar; filtro que no filtra; enseñar el botón a
 * cualquiera.
 */

const { abrirSalaGeneral } = vi.hoisted(() => ({ abrirSalaGeneral: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { default: ChannelsSection } = await import("@/components/comms/ChannelsSection");
const { useTasksStore } = await import("@/store/tasks.store");
const { useChatStore } = await import("@/store/chat.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useAuthStore } = await import("@/store/auth.store");
const { usePlacesStore } = await import("@/store/places.store");
const { useVoice } = await import("@/store/voice.store");
const { useLayoutStore } = await import("@/store/layout.store");

const space = (id: string, name: string, kind?: string) =>
  ({ id, orgId: "org-1", name, color: "", kind, folders: [], lists: [], people: [] }) as unknown as SpaceTree;

let where = "";
function Where() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}

const mount = (url = "/chat", filter = "") =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ChannelsSection filter={filter} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const names = () => [...document.querySelectorAll("section button[type=button] span.truncate")].map((e) => e.textContent);
const active = () => document.querySelector('[aria-current="page"]')?.textContent ?? null;

beforeEach(() => {
  abrirSalaGeneral.mockResolvedValue(undefined);
  useTasksStore.setState({
    tree: [space("sp-1", "Boaty"), space("sp-2", "Eleva"), space("sp-g", "General", "general")],
    abrirSalaGeneral,
  } as never);
  useChatStore.setState({ unreadBySpace: { "sp-2": 4 } } as never);
  useOrgsStore.setState({
    orgs: [{ id: "org-1", name: "Guz", slug: "guz", role: "member", memberCount: 2 }],
    currentOrgId: "org-1",
  } as never);
  useAuthStore.setState({ session: { id: "u-1", username: "ana", superadmin: false }, accessToken: "t" } as never);
  usePlacesStore.setState({ byOrg: {} });
  useVoice.setState({ ocupacion: {} } as never);
  useLayoutStore.setState({ expanded: {} });
});
afterEach(cleanup);

describe("el orden", () => {
  it("la sala general va la primera, por delante de los canales de trabajo", () => {
    mount();
    expect(names().filter((n) => ["General", "Boaty", "Eleva"].includes(n ?? ""))).toEqual(["General", "Boaty", "Eleva"]);
  });
});

describe("la fila marcada es la que está en pantalla", () => {
  it("sin elegir, la general", () => {
    mount("/chat");
    expect(active()).toContain("General");
  });

  it("lo pedido en la dirección manda", () => {
    mount("/chat?space=sp-1");
    expect(active()).toContain("Boaty");
  });

  // Sin `?space=`, la página abre el último canal de esta org. Si la fila
  // resolviera por su cuenta marcaría la general con Eleva en pantalla.
  it("sin pedir nada, el último de esta org, como la página", () => {
    usePlacesStore.getState().remember("org-1", { spaceId: "sp-2" });
    mount("/chat");
    expect(active()).toContain("Eleva");
  });

  it("en la lista del teléfono no se marca ninguno: no hay canal en pantalla", () => {
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <ChannelsSection plain />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: /General/ })).toBeTruthy();
    expect(active()).toBeNull();
  });

  it("fuera de Canales no se marca ninguno", () => {
    mount("/dm");
    expect(active()).toBeNull();
  });
});

describe("cada fila", () => {
  it("lleva sus no leídos, y la voz sólo si hay alguien", () => {
    useVoice.setState({ ocupacion: { "sp-1": [{ identity: "u-2", name: "Marta" }] } } as never);
    mount();
    const eleva = screen.getByRole("button", { name: /Eleva/ });
    expect(eleva.textContent).toContain("4");
    expect(screen.getByTitle("In voice: Marta")).toBeTruthy();
    expect(screen.getAllByTitle(/In voice/)).toHaveLength(1);
    // Y quién, colgando del canal.
    expect(screen.getByText("Marta")).toBeTruthy();
  });

  it("pulsarla lleva a ese canal por la dirección", () => {
    mount("/my-work");
    fireEvent.click(screen.getByRole("button", { name: /Eleva/ }));
    expect(where).toBe("/chat?space=sp-2");
  });
});

describe("la sección", () => {
  it("se pliega pulsando la cabecera, y se recuerda por org", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Channels/ }));
    expect(screen.queryByRole("button", { name: /Boaty/ })).toBeNull();
    expect(useLayoutStore.getState().expanded["org-1/comms"]).toEqual({ "section:channels": false });
  });

  // Como en Slack: plegada sigue a la vista la que tienes delante (General) y
  // la que tiene algo sin leer (Eleva). Mutante: sin `peek`.
  it("plegada deja a la vista la abierta y las que tienen no leídos", () => {
    useLayoutStore.setState({ expanded: { "org-1/comms": { "section:channels": false } } });
    mount("/chat");
    expect(screen.getByRole("button", { name: /General/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /Eleva/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Boaty/ })).toBeNull();
  });

  it("el filtro deja lo que casa, sin distinguir mayúsculas", () => {
    mount("/chat", "ELE");
    expect(screen.getByRole("button", { name: /Eleva/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Boaty/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /General/ })).toBeNull();
  });

  // Plegada y con filtro: lo que buscas no puede quedar tras un chevrón.
  it("plegada, se abre mientras el filtro encuentra algo", () => {
    useLayoutStore.setState({ expanded: { "org-1/comms": { "section:channels": false } } });
    mount("/chat", "boa");
    expect(screen.getByRole("button", { name: /Boaty/ })).toBeTruthy();
  });

  it("sin nada que case, no se pinta", () => {
    mount("/chat", "zzz");
    expect(document.querySelector("section")).toBeNull();
  });
});

describe("abrir la sala general es del admin", () => {
  const withoutGeneral = () =>
    useTasksStore.setState({ tree: [space("sp-1", "Boaty")], abrirSalaGeneral } as never);
  const asRole = (role: string) =>
    useOrgsStore.setState({ orgs: [{ id: "org-1", name: "Guz", slug: "guz", role, memberCount: 2 }] } as never);

  it("un miembro corriente no ve el botón", () => {
    withoutGeneral();
    mount();
    expect(screen.queryByText("Open a general room")).toBeNull();
  });

  it("el admin sí", () => {
    withoutGeneral();
    asRole("admin");
    mount();
    expect(screen.getByText("Open a general room")).toBeTruthy();
  });

  it("y el superadmin también, aunque no sea admin de la org", () => {
    withoutGeneral();
    useAuthStore.setState({ session: { id: "u-1", username: "ana", superadmin: true } } as never);
    mount();
    expect(screen.getByText("Open a general room")).toBeTruthy();
  });

  // Ofrecer abrirla cuando ya está sería un botón que miente sobre lo que hace.
  it("nadie lo ve cuando la sala ya existe", () => {
    asRole("admin");
    mount();
    expect(screen.queryByText("Open a general room")).toBeNull();
  });

  it("pulsarlo la abre en la org en pantalla", async () => {
    withoutGeneral();
    asRole("admin");
    mount();
    fireEvent.click(screen.getByText("Open a general room"));
    await vi.waitFor(() => expect(abrirSalaGeneral).toHaveBeenCalledWith("org-1"));
  });
});
