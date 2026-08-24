import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SpaceTree } from "@/types/task";
import type { ReportProject } from "@/types/report";

/**
 * Una integración server-to-server, vista desde la organización.
 *
 * Dos cosas que la ficha no decía y que son la primera pregunta que se hace de
 * ella: **dónde acaba lo que manda**, y qué pasa si no acaba en ninguna parte.
 * El campo existía en la respuesta del servidor desde el principio y la app lo
 * ignoraba, así que se subían reportes sin saber a qué lista caían.
 *
 * Y de paso lo que el formulario manda al guardar: sólo lo que se tocó. Antes
 * iba el formulario entero porque el servidor borraba lo omitido — cambiar el
 * nombre le borraba el webhook a un cliente.
 */

const { updateProject, tree, fetchTree } = vi.hoisted(() => ({
  updateProject: vi.fn(),
  tree: { current: [] as SpaceTree[] },
  fetchTree: vi.fn(),
}));
const orgActual = { current: "org-1" };

const proyectos = { current: [] as ReportProject[] };

vi.mock("@/store/reports.store", () => ({
  useReportsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      projects: proyectos.current,
      fetchProjects: vi.fn().mockResolvedValue(undefined),
      createProject: vi.fn(),
      updateProject,
      rotateProjectKey: vi.fn(),
      setProjectActive: vi.fn(),
      deleteProject: vi.fn(),
    }),
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ tree: tree.current, fetchTree }),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ currentOrgId: orgActual.current, listMembers: vi.fn().mockResolvedValue([]) }),
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { default: OrgIntegrations } = await import("@/components/org/OrgIntegrations");

const ARBOL = [
  {
    id: "esp-1",
    orgId: "org-1",
    name: "Boaty",
    color: "#0ff",
    lists: [],
    folders: [{ id: "car-1", name: "web", lists: [{ id: "li-honda", name: "Tasks" }] }],
    people: [],
  },
  // Una organización que no es la suya. El árbol del store es el que dejó la
  // última pantalla, así que esto no es rebuscado: es el estado normal cuando
  // se abre Ajustes después de haber estado en otra organización.
  {
    id: "esp-9",
    orgId: "org-otra",
    name: "Latinet",
    color: "#000",
    lists: [{ id: "li-ajena", name: "salud en casa" }],
    folders: [],
    people: [],
  },
] as unknown as SpaceTree[];

const INTEGRACION = {
  id: "proy-1",
  orgId: "org-1",
  name: "boaty",
  slug: "boaty",
  platform: "app",
  allowedOrigins: [],
  rateLimitPerHour: 500,
  rateLimitPerReporterPerHour: 7,
  isActive: true,
  webhookUrl: "https://boaty.app/hooks/cac",
  webhookConfigured: true,
  createdAt: "2026-08-01T00:00:00Z",
  reportsThisMonth: 12,
} as unknown as ReportProject;

const pintar = (extra: Partial<ReportProject> = {}) => {
  proyectos.current = [{ ...INTEGRACION, ...extra }];
  tree.current = ARBOL;
  return render(<OrgIntegrations canManage />);
};

beforeEach(() => {
  updateProject.mockResolvedValue(undefined);
  fetchTree.mockReset();
  fetchTree.mockResolvedValue(undefined);
  orgActual.current = "org-1";
});
afterEach(cleanup);

describe("dónde caen sus reportes", () => {
  it("lo dice con el nombre de la lista y su ruta, no con el uuid", () => {
    pintar({ listId: "li-honda" });
    expect(screen.getByText("Boaty · web · Tasks")).toBeTruthy();
    expect(screen.queryByText("li-honda")).toBeNull();
  });

  // El estado que hay que ver de lejos: la integración acepta reportes y no los
  // entrega en ningún sitio. Es lo que le pasa a una recién creada.
  it("avisa cuando no caen en ninguna parte", () => {
    pintar();
    expect(screen.getByText("nowhere — anything it sends is being lost")).toBeTruthy();
  });

  // Puede apuntar a una lista de otra organización o a una borrada. Decirlo es
  // mejor que enseñar el uuid, y mejor que decir «ninguna», que sería falso.
  it("distingue «en otra organización» de «en ninguna»", () => {
    pintar({ listId: "li-que-no-existe-aqui" });
    expect(screen.getByText("a list outside this organization")).toBeTruthy();
    expect(screen.queryByText("nowhere — anything it sends is being lost")).toBeNull();
  });

  it("se puede elegir la lista desde aquí", async () => {
    pintar();
    fireEvent.click(screen.getByText("Edit"));
    const select = screen.getByRole("combobox", { name: /Reports arrive in/i });
    fireEvent.change(select, { target: { value: "li-honda" } });
    fireEvent.click(screen.getByText("Save"));
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(updateProject.mock.calls[0][1]).toEqual({ listId: "li-honda" });
  });

  // Quitarla no «desconfigura» la integración: hace que todo lo que le manden se
  // pierda sin decir nada. El servidor lo rechaza; el desplegable no lo ofrece.
  it("no ofrece dejarla sin lista cuando ya tiene una", () => {
    pintar({ listId: "li-honda" });
    fireEvent.click(screen.getByText("Edit"));
    const select = screen.getByRole("combobox", { name: /Reports arrive in/i });
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Boaty · web · Tasks",
    ]);
  });
});

describe("el árbol que se ofrece es el de esta organización", () => {
  /**
   * Se recarga al cambiar de organización, **aunque ya hubiera uno cargado**.
   *
   * Estaba escrito como «si está vacío, cárgalo», y el que quedaba en memoria
   * podía ser de otra organización: el navegador lo recarga al cambiar de org,
   * pero en Ajustes no está montado. De ahí salían las listas ajenas.
   */
  it("se pide de nuevo cuando cambia la organización", () => {
    const r = pintar({ listId: "li-honda" });
    expect(fetchTree).toHaveBeenCalledTimes(1);

    orgActual.current = "org-otra";
    r.rerender(<OrgIntegrations canManage />);
    expect(fetchTree).toHaveBeenCalledTimes(2);
  });

  // El caso exacto que fallaba: había árbol, así que no se pedía ninguno.
  it("se pide aunque ya hubiera uno cargado", () => {
    tree.current = ARBOL;
    proyectos.current = [INTEGRACION];
    render(<OrgIntegrations canManage />);
    expect(fetchTree).toHaveBeenCalled();
  });
});

describe("no se puede elegir la lista de otra organización", () => {
  /**
   * El fallo que llegó de producción: subir el límite de una integración
   * respondía `inbox-other-org`.
   *
   * El desplegable ofrecía las listas del árbol que hubiera cargado, que podía
   * ser el de **otra** organización —el navegador lo recarga al cambiar de org,
   * pero en Ajustes no está montado—. El servidor lo rechazaba, y con razón:
   * poner ahí la bandeja sería entregarle los reportes de un cliente a gente de
   * otra organización. Que el servidor tenga que defenderse de la pantalla es
   * el fallo; la pantalla no debe ofrecerlo.
   */
  it("la lista ajena no está entre las opciones", () => {
    pintar({ listId: "li-honda" });
    fireEvent.click(screen.getByText("Edit"));
    const select = screen.getByRole("combobox", { name: /Reports arrive in/i });
    const valores = [...select.querySelectorAll("option")].map((o) => o.getAttribute("value"));
    expect(valores).not.toContain("li-ajena");
    expect(valores).toEqual(["li-honda"]);
  });

  it("y su nombre tampoco se ofrece", () => {
    pintar();
    fireEvent.click(screen.getByText("Edit"));
    const select = screen.getByRole("combobox", { name: /Reports arrive in/i });
    expect(select.textContent).not.toContain("salud en casa");
  });
});

describe("guardar manda sólo lo que cambió", () => {
  it("cambiar el nombre no arrastra el webhook ni el resto", async () => {
    pintar({ listId: "li-honda" });
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "boaty v2" } });
    fireEvent.click(screen.getByText("Save"));
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(updateProject.mock.calls[0][1]).toEqual({ name: "boaty v2" });
  });

  // Borrar sigue siendo posible y sigue siendo explícito: vaciar la caja manda
  // "" a propósito, que es lo que el servidor entiende como «retíralo».
  it("vaciar el webhook sí lo manda vacío", async () => {
    pintar({ listId: "li-honda" });
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByPlaceholderText("https://example.com/hooks/cac"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByText("Save"));
    await vi.waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(updateProject.mock.calls[0][1]).toEqual({ webhookUrl: "" });
  });

  // Nadie que sólo venía a mirar espera que abrir y cerrar el formulario
  // escriba nada.
  it("no manda nada si no se tocó nada", async () => {
    pintar({ listId: "li-honda" });
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Save"));
    expect(updateProject).not.toHaveBeenCalled();
  });
});
