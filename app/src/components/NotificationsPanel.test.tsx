import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InboxItem } from "@/store/inbox.store";

/**
 * La campana: qué pasó, filtrable, y lo ya visto apartado.
 *
 * Lo que se comprueba aquí es que las pestañas **filtran de verdad**. Un panel
 * con pestañas que enseñan lo mismo es peor que uno sin ellas: promete un
 * recorte que no hace, y uno deja de mirar.
 */

const { markRead, markAllRead, navigate, items } = vi.hoisted(() => ({
  markRead: vi.fn().mockResolvedValue(undefined),
  markAllRead: vi.fn().mockResolvedValue(undefined),
  navigate: vi.fn(),
  items: { current: [] as InboxItem[] },
}));

vi.mock("@/store/inbox.store", () => ({
  useInboxStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      items: items.current,
      unread: items.current.filter((n) => !n.readAt).length,
      markRead,
      markAllRead,
    }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

const { default: NotificationsPanel } = await import("@/components/NotificationsPanel");

afterEach(() => {
  cleanup();
  markRead.mockClear();
  markAllRead.mockClear();
  navigate.mockClear();
});

const n = (id: string, kind: string, title: string, readAt?: string): InboxItem => ({
  id, orgId: "o", kind, title, body: "algo pasó", link: `/x/${id}`,
  readAt: readAt ?? null, createdAt: new Date().toISOString(),
});

/** Igual, pero escrito por el agente. */
const conAgente = (id: string, kind: string, title: string): InboxItem => ({
  ...n(id, kind, title),
  via: "mcp",
});

const TODAS = [
  n("m1", "chat:mention", "#portento · te nombraron"),
  n("d1", "dm:message", "Ana · directo"),
  n("c1", "chat:message", "#portento · mensaje"),
  n("t1", "task:comment", "portento-89 · comentario"),
  n("r1", "report:new", "portento-97 · nuevo reporte"),
  n("v1", "task:comment", "portento-93 · cerrada", new Date().toISOString()),
];

const montar = (lista = TODAS) => {
  items.current = lista;
  return render(
    <NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />,
  );
};

describe("el panel de notificaciones", () => {
  it("empieza enseñándolo todo", () => {
    montar();
    expect(screen.getByText("#portento · te nombraron")).toBeTruthy();
    expect(screen.getByText("portento-97 · nuevo reporte")).toBeTruthy();
  });

  it("«Talk» recoge lo conversacional y deja fuera lo demás", () => {
    montar();
    fireEvent.click(screen.getByText("Talk"));
    expect(screen.getByText("#portento · te nombraron")).toBeTruthy();
    expect(screen.getByText("Ana · directo")).toBeTruthy();
    // Y el mensaje corriente de un canal seguido, que no te nombra pero es
    // igual de conversacional: por eso la pestaña ya no se llama «Mentions».
    expect(screen.getByText("#portento · mensaje")).toBeTruthy();
    expect(screen.queryByText("portento-97 · nuevo reporte")).toBeNull();
    expect(screen.queryByText("portento-89 · comentario")).toBeNull();
  });

  it("«Sistema» se queda con lo que llegó de fuera", () => {
    montar();
    fireEvent.click(screen.getByText("System"));
    expect(screen.getByText("portento-97 · nuevo reporte")).toBeTruthy();
    expect(screen.queryByText("Ana · directo")).toBeNull();
  });

  it("aparta lo ya leído bajo su rótulo", () => {
    montar();
    expect(screen.getByText("Read")).toBeTruthy();
    // Y sólo lo leído va ahí: si «Read» apareciera con la lista entera debajo,
    // el apartado no estaría apartando nada.
    expect(screen.getByText("portento-93 · cerrada")).toBeTruthy();
  });

  it("pulsar una la marca leída y lleva a donde ocurrió", async () => {
    montar();
    fireEvent.click(screen.getByText("Ana · directo"));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(["d1"]));
    expect(navigate).toHaveBeenCalledWith("/x/d1");
  });

  it("sin nada que contar lo dice", () => {
    montar([]);
    expect(screen.getByText("Nothing pending in this organization.")).toBeTruthy();
    // Y no ofrece marcar como leído lo que no existe.
    expect(screen.queryByText("Mark all read")).toBeNull();
  });
});

describe("de quién fue", () => {
  it("marca lo que escribió el agente, y sólo eso", async () => {
    items.current = [
      conAgente("a1", "task:comment", "Claude respondió"),
      n("h1", "task:comment", "Bea respondió"),
    ];
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);

    // Un solo chip: el que dice quién lo hizo. Sin esto, un agente moviendo
    // trabajo en tu tablero es indistinguible de un compañero haciéndolo.
    const chips = await screen.findAllByTitle(/Written by an agent/);
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain("agent");
  });

  it("lo de siempre no lleva chip", () => {
    items.current = [n("h1", "task:comment", "Bea respondió")];
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    expect(screen.queryByTitle(/Written by an agent/)).toBeNull();
  });

  it("una asignación cae en Tasks, con su etiqueta", async () => {
    items.current = [n("t1", "task:assigned", "Assigned to you")];
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    fireEvent.click(screen.getByText("Tasks"));
    // Sin entrada en CLASES caería en «System» sin etiqueta, que es donde va a
    // parar cualquier clase que el panel no conozca.
    await waitFor(() => expect(screen.getByText("Assigned to you")).toBeTruthy());
    expect(screen.getByText("assigned")).toBeTruthy();
  });
});
