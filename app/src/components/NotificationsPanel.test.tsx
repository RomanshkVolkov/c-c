import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { InboxItem } from "@/store/inbox.store";

/**
 * La campana: qué pasó, filtrable, y lo ya visto apartado.
 *
 * Lo que se comprueba aquí es que las pestañas **filtran de verdad**. Un panel
 * con pestañas que enseñan lo mismo es peor que uno sin ellas: promete un
 * recorte que no hace, y uno deja de mirar.
 */

const { markRead, markReadGroup, markAllRead, navigate, items, groups } = vi.hoisted(() => ({
  markRead: vi.fn().mockResolvedValue(undefined),
  markReadGroup: vi.fn().mockResolvedValue(undefined),
  markAllRead: vi.fn().mockResolvedValue(undefined),
  navigate: vi.fn(),
  items: { current: [] as InboxItem[] },
  // Lo que el servidor cuenta de cada conversación, mirando la bandeja entera.
  // Vacío por defecto: la mayoría de las pruebas no hablan de contadores.
  groups: { current: [] as { key: string; label: string; total: number; unread: number }[] },
}));

vi.mock("@/store/inbox.store", () => ({
  useInboxStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      items: items.current,
      unread: items.current.filter((n) => !n.readAt).length,
      groups: groups.current,
      markRead,
      markReadGroup,
      markAllRead,
    }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

const { default: NotificationsPanel } = await import("@/components/NotificationsPanel");

afterEach(() => {
  cleanup();
  groups.current = [];
  markReadGroup.mockClear();
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

describe("plegar lo del mismo sitio", () => {
  /**
   * Dos mensajes del mismo canal, que es el caso que motivó todo esto.
   *
   * Con instantes distintos a propósito: la cabecera enseña el **más nuevo**, y
   * con la misma marca de tiempo en los dos no habría forma de saber cuál es —
   * la prueba pasaría o fallaría según el orden del array, que no es la regla.
   */
  const mismoCanal = () => [
    {
      ...n("c1", "chat:message", "#portento"),
      link: "/chat?space=s1", body: "Ana: lo primero",
      createdAt: "2026-08-27T10:00:00Z",
    },
    {
      ...n("c2", "chat:message", "#portento"),
      link: "/chat?space=s1", body: "Ana: lo último",
      createdAt: "2026-08-27T11:00:00Z",
    },
  ];

  /** El contador del grupo, no el del panel: los dos dicen números. */
  const contador = () =>
    screen.getByText("#portento").closest("button")!.querySelector(".bg-primary\\/15")?.textContent;

  it("una fila con contador, no dos", () => {
    items.current = mismoCanal();
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    expect(contador()).toBe("2");
    // Lo viejo no se ve hasta abrir: eso es plegar.
    expect(screen.queryByText("Ana: lo primero")).toBeNull();
    expect(screen.getByText("Ana: lo último")).toBeTruthy();
  });

  it("y al abrirla salen las dos", () => {
    items.current = mismoCanal();
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    fireEvent.click(screen.getByLabelText(/^Expand /));
    expect(screen.getByText("Ana: lo primero")).toBeTruthy();
  });

  it("volver a pulsar la cierra", () => {
    items.current = mismoCanal();
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    fireEvent.click(screen.getByLabelText(/^Expand /));
    fireEvent.click(screen.getByLabelText(/^Collapse /));
    expect(screen.queryByText("Ana: lo primero")).toBeNull();
  });

  // Abrir la conversación es haberla leído: dejar el contador puesto obligaría
  // a volver a la campana a limpiarlo a mano.
  it("pulsar la cabecera marca el grupo entero y lleva al canal", () => {
    items.current = mismoCanal();
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    fireEvent.click(screen.getByText("#portento"));
    // Por clave y no por ids: los ids que tiene la app son los que cupieron en
    // la página, y el grupo puede tener trescientos.
    expect(markReadGroup).toHaveBeenCalledWith("space:s1");
    expect(navigate).toHaveBeenCalledWith("/chat?space=s1");
  });

  // El estado de apertura va por clave de grupo. Indexado por índice o por id de
  // fila, cada mensaje que llegara cerraría el grupo que estás mirando —
  // invisible en desarrollo, insufrible en un canal vivo.
  it("un aviso nuevo no cierra el grupo que tenías abierto", () => {
    items.current = mismoCanal();
    const r = render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    fireEvent.click(screen.getByLabelText(/^Expand /));

    // `releerBandeja()` reemplaza el array entero en cada evento, y el feed
    // llega **del más nuevo al más viejo** — así que el mensaje que acaba de
    // entrar va delante. Ponerlo al final haría que la prueba pasara con el
    // estado indexado por el id de la primera fila, que es justo el fallo.
    items.current = [
      {
        ...n("c3", "chat:message", "#portento"),
        link: "/chat?space=s1", body: "Ana: y otra",
        createdAt: "2026-08-27T12:00:00Z",
      },
      ...mismoCanal(),
    ];
    r.rerender(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    expect(screen.getByText("Ana: lo primero")).toBeTruthy();
  });

  // Que te nombren dentro de un canal charlatán es lo único que decide si hay
  // que abrirlo ya.
  // La cabecera de un grupo lleva su etiqueta igual que una fila suelta. Sin
  // esta prueba, un fallo al traducirla dejaría la clave cruda en pantalla
  // —«notifications:kind.channel»— y ninguna prueba lo notaría.
  it("la cabecera del grupo lleva su etiqueta, traducida", () => {
    items.current = mismoCanal();
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    const cabecera = screen.getByText("#portento").closest("button")!;
    expect(within(cabecera).getByText("channel")).toBeTruthy();
    expect(cabecera.textContent).not.toContain("notifications:");
  });

  it("una mención dentro se ve sin abrir", () => {
    items.current = [
      { ...n("c1", "chat:message", "#portento"), link: "/chat?space=s1" },
      { ...n("m1", "chat:mention", "Mentioned in #portento"), link: "/chat?space=s1" },
    ];
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    // El envoltorio «Mentioned in » no es el nombre del canal.
    expect(screen.getByText("#portento")).toBeTruthy();
    expect(screen.queryByText("Mentioned in #portento")).toBeNull();
    // Y el icono lo dice: la arroba en vez del almohadilla del canal. Es lo
    // único que distingue «hay mensajes» de «te nombraron ahí dentro».
    const cabecera = screen.getByText("#portento").closest("button")!;
    expect(cabecera.querySelector(".lucide-at-sign")).not.toBeNull();
  });

  // El contador dice lo que hay en la base, no lo que cupo en la página. Sin
  // esto, «#portento (2)» con trescientos guardados es una cifra inventada.
  it("el contador del servidor manda sobre lo que llegó", () => {
    items.current = mismoCanal();
    groups.current = [{ key: "space:s1", label: "#portento", total: 47, unread: 12 }];
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    expect(contador()).toBe("12");
  });

  // Enseñar 47 y desplegar 2 sin decir nada parece que faltan avisos.
  it("y al abrirlo dice cuántos se están viendo", () => {
    items.current = mismoCanal();
    groups.current = [{ key: "space:s1", label: "#portento", total: 47, unread: 12 }];
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    fireEvent.click(screen.getByLabelText(/^Expand /));
    expect(screen.getByText(/Showing 2 of 47/)).toBeTruthy();
  });

  // Y cuando están todos, no se dice nada: sería ruido.
  it("sin nada escondido no avisa de nada", () => {
    items.current = mismoCanal();
    groups.current = [{ key: "space:s1", label: "#portento", total: 2, unread: 2 }];
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    fireEvent.click(screen.getByLabelText(/^Expand /));
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  // Un aviso suelto no puede llevar más adornos que información.
  it("una sola notificación se pinta como siempre", () => {
    items.current = [{ ...n("c1", "chat:message", "#portento"), link: "/chat?space=s1" }];
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);
    expect(screen.queryByLabelText(/^Expand /)).toBeNull();
  });
});

describe("de quién fue", () => {
  // Reescrito al agrupar: antes los dos avisos tenían enlaces distintos, así
  // que no se plegaban y la prueba **pasaba por accidente**. Ahora comparten
  // ficha, se pliegan, y se afirma la regla nueva — la cabecera avisa de que
  // dentro hay algo de un agente, con una frase distinta de la de una fila.
  it("marca lo que escribió el agente, y sólo eso", async () => {
    items.current = [
      { ...conAgente("a1", "task:comment", "Claude respondió"), link: "/tasks?task=t9" },
      { ...n("h1", "task:comment", "Bea respondió"), link: "/tasks?task=t9" },
    ];
    render(<NotificationsPanel open onOpenChange={() => {}} onOpenPrefs={() => {}} />);

    // La cabecera lo dice sin abrir, y dice cuántos.
    expect(await screen.findByTitle(/Includes 1 written by an agent/)).toBeTruthy();
    // Plegado no se ve ninguna fila suelta con su chip.
    expect(screen.queryByTitle(/^Written by an agent/)).toBeNull();

    fireEvent.click(screen.getByLabelText(/^Expand /));

    // Y dentro, exactamente uno: el del agente. Sin esto, un agente moviendo
    // trabajo en tu tablero es indistinguible de un compañero haciéndolo.
    const chips = await screen.findAllByTitle(/^Written by an agent/);
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
