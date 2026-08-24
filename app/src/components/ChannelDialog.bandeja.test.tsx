import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { SpaceTree } from "@/types/task";
import type { ReportProject } from "@/types/report";

/**
 * Mirando una lista: **qué cae aquí**.
 *
 * En una integración la pregunta es «dónde acaba lo suyo»; en una lista es la
 * contraria, y no se podía contestar. Se abría este diálogo en la lista de un
 * cliente y no decía si sus reportes caían dentro — que es exactamente lo que
 * pasó subiendo reportes a boaty sin saber dónde aparecían.
 *
 * Y la otra mitad: apuntar aquí una integración **libre**, sin bandeja. Libre es
 * eso y no «sin usar»: la que ya entrega en otra lista no se ofrece, porque
 * moverla es quitarle la suya y eso se hace donde se ve lo que se quita.
 *
 * El `Select` va sustituido por uno nativo a propósito: el desplegable lo prueba
 * su propia librería, y lo que aquí importa es **qué opciones se le dan**.
 */

const { setChannelInbox, fetchChannel, fetchChannels, canales, tree } = vi.hoisted(() => ({
  setChannelInbox: vi.fn(),
  fetchChannel: vi.fn(),
  // Estable a propósito. Devolviendo un `vi.fn()` nuevo en cada render, el
  // efecto que lee el canal lo veía como una dependencia distinta y volvía a
  // «Reading…» con cada tecla — el store de verdad devuelve siempre la misma.
  fetchChannels: vi.fn(),
  canales: { current: [] as ReportProject[] },
  tree: { current: [] as SpaceTree[] },
}));

const acciones = {
  bindNode: vi.fn(),
  fetchChannel,
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  rotateChannelKey: vi.fn(),
  setChannelInbox,
};

vi.mock("@/store/tasks.store", () => ({
  useTasksStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ channels: canales.current, fetchChannels, tree: tree.current }),
    { getState: () => acciones },
  ),
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select data-testid="picker" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const { default: ChannelDialog } = await import("@/components/ChannelDialog");

const ARBOL = [
  {
    id: "esp-1",
    orgId: "org-1",
    name: "Boaty",
    color: "#0ff",
    lists: [{ id: "li-aqui", name: "Tasks" }],
    folders: [{ id: "car-1", name: "otros", lists: [{ id: "li-alla", name: "Entrada" }] }],
    people: [],
  },
] as unknown as SpaceTree[];

const proyecto = (extra: Partial<ReportProject>) =>
  ({
    id: "proy-1",
    orgId: "org-1",
    name: "boaty",
    slug: "boaty",
    platform: "app",
    allowedOrigins: [],
    rateLimitPerHour: 500,
    rateLimitPerReporterPerHour: 7,
    isActive: true,
    webhookUrl: "",
    webhookConfigured: false,
    createdAt: "2026-08-01T00:00:00Z",
    ...extra,
  }) as unknown as ReportProject;

/** Abre el diálogo sobre la lista `li-aqui`. */
const abrir = async (canal: ReportProject | null, todos: ReportProject[]) => {
  canales.current = todos;
  tree.current = ARBOL;
  fetchChannel.mockResolvedValue(canal);
  const r = render(
    <ChannelDialog kind="list" id="li-aqui" name="Tasks" open onOpenChange={() => {}} />,
  );
  await screen.findByText("Reports that arrive here");
  return r;
};

/**
 * La sección de la bandeja, no el diálogo entero.
 *
 * «boaty» sale también como opción de «Belongs to» y el desplegable de aquí es
 * el segundo de la pantalla: buscar sueltos encontraría los dos y la prueba
 * pasaría por el motivo equivocado.
 */
const seccion = () =>
  within(screen.getByText("Reports that arrive here").closest("section")!);

beforeEach(() => {
  setChannelInbox.mockResolvedValue(undefined);
  fetchChannels.mockResolvedValue(undefined);
  fetchChannel.mockReset();
});
afterEach(cleanup);

describe("qué cae en esta lista", () => {
  it("nombra a quien entrega aquí", async () => {
    const aqui = proyecto({ listId: "li-aqui" });
    await abrir(aqui, [aqui]);
    expect(seccion().getByText("boaty")).toBeTruthy();
    expect(seccion().getByText("delivers into this list.")).toBeTruthy();
  });

  it("y dice claramente cuando no cae nada", async () => {
    await abrir(null, [proyecto({ listId: "li-alla" })]);
    expect(
      screen.getByText("Nothing delivers here — no integration is pointed at this list."),
    ).toBeTruthy();
  });

  // El caso que desconcierta: la lista es del cliente y sus reportes salen en
  // otro sitio. Pertenecer y recibir son cosas distintas, y ésta es la única
  // pantalla donde se ven las dos a la vez.
  it("avisa cuando el cliente de esta lista entrega en otra", async () => {
    const canal = proyecto({ listId: "li-alla" });
    await abrir(canal, [canal]);
    expect(screen.getByText("Boaty · otros · Entrada")).toBeTruthy();
    expect(screen.getByText("Send its reports here instead")).toBeTruthy();
  });

  it("y moverla manda su bandeja a esta lista", async () => {
    const canal = proyecto({ listId: "li-alla" });
    await abrir(canal, [canal]);
    fireEvent.click(screen.getByText("Send its reports here instead"));
    await vi.waitFor(() => expect(setChannelInbox).toHaveBeenCalledWith("proy-1", "li-aqui"));
  });

  // Ya entrega aquí: ofrecer moverla otra vez es ofrecer nada.
  it("no ofrece moverla si ya entrega aquí", async () => {
    const canal = proyecto({ listId: "li-aqui" });
    await abrir(canal, [canal]);
    expect(screen.queryByText("Send its reports here instead")).toBeNull();
  });
});

describe("apuntar una integración libre", () => {
  const libre = proyecto({ id: "proy-libre", name: "portento" });
  const ocupada = proyecto({ id: "proy-ocupada", name: "otro cliente", listId: "li-alla" });

  it("ofrece las que no tienen bandeja", async () => {
    await abrir(null, [libre, ocupada]);
    const opciones = [...seccion().getByTestId("picker").querySelectorAll("option")].map(
      (o) => o.textContent,
    );
    expect(opciones).toContain("portento");
  });

  // Moverle la bandeja a otro cliente desde aquí sería quitarle la suya sin que
  // nadie lo vea. Se hace en su ficha, donde se lee lo que se está quitando.
  it("y no las que ya entregan en otra parte", async () => {
    await abrir(null, [libre, ocupada]);
    const opciones = [...seccion().getByTestId("picker").querySelectorAll("option")].map(
      (o) => o.textContent,
    );
    expect(opciones).not.toContain("otro cliente");
  });

  it("apuntarla manda su bandeja a esta lista", async () => {
    await abrir(null, [libre]);
    fireEvent.change(seccion().getByTestId("picker"), { target: { value: "proy-libre" } });
    fireEvent.click(screen.getByText("Point it here"));
    await vi.waitFor(() => expect(setChannelInbox).toHaveBeenCalledWith("proy-libre", "li-aqui"));
  });

  // Sin elegir, el botón está apagado — que es lo que se ve, y por tanto lo que
  // hay que afirmar. Escrito como «pulsar no manda nada» la prueba pasaba
  // igual con el guarda de `apuntarAqui` quitado, porque un botón apagado no
  // dispara nada: comprobaba el `disabled` creyendo comprobar el guarda. El
  // guarda se queda de todos modos, pero es defensa en profundidad y no hay
  // forma de llegar a él desde la interfaz.
  it("sin elegir ninguna, no se puede apuntar", async () => {
    await abrir(null, [libre]);
    const boton = screen.getByText("Point it here").closest("button")!;
    expect(boton.disabled).toBe(true);
    fireEvent.click(boton);
    expect(setChannelInbox).not.toHaveBeenCalled();
  });

  // Un espacio no recibe nada, así que no hay nada que apuntarle: decirlo evita
  // buscar aquí lo que se pone en la lista.
  it("en un espacio no se ofrece: no es una bandeja", async () => {
    canales.current = [libre];
    tree.current = ARBOL;
    fetchChannel.mockResolvedValue(proyecto({ listId: "li-aqui" }));
    render(<ChannelDialog kind="space" id="esp-1" name="Boaty" open onOpenChange={() => {}} />);
    await screen.findByText("Reports arrive in");
    expect(screen.queryByText("Point it here")).toBeNull();
    expect(
      screen.getByText("A space isn't an inbox: open the list you want and point it there."),
    ).toBeTruthy();
  });
});
