import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * La bandeja de peticiones de ejecución (decisión 4d28f4ab).
 *
 * Lo que se fija:
 * 1. Aprobar pide lo que el protocolo pide: el nombre del servidor escrito a
 *    mano si es destructivo, y reconocer las banderas rojas si las hay. Sin
 *    eso el botón no se deja apretar (y el backend lo vuelve a exigir).
 * 2. Aprobar se confirma y manda exactamente la decisión; rechazar no pide
 *    confirmación.
 * 3. Quien no es admin no ve botones: ve quién decide.
 * 4. Una autorizada enseña el comando con el que se corre.
 * 5. Una respuesta con otra forma no rompe la pestaña.
 */

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("@/lib/api", () => ({ api }));
const { confirmar } = vi.hoisted(() => ({ confirmar: vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => confirmar }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

const { default: ProvisioningRequests, canApprove, grantCommand, isStale, STALE_CHECK_MS, visibleRequests, RECENT_CLOSED } = await import("./ProvisioningRequests");
const { useAuthStore } = await import("@/store/auth.store");
const en = (await import("@/locales/en/common.json")).default.provisionRequests;
const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

const server = { id: "srv-1", name: "gstd" };

function request(over: Record<string, unknown> = {}) {
  return {
    id: "rq-1", serverId: "srv-1", playbook: "swarm", project: "ansible", risk: "change",
    verify: "swarm-verify", rollback: "swarm-teardown", configSeq: 3, reason: "levantar Traefik",
    requestedBy: "u-1", requestedByName: "Jose", source: "mcp", status: "awaiting_approval",
    check: { hosts: ["gstd"], ok: 20, changed: 4, unreachable: 0, failed: 0, changedTasks: ["Instalar Traefik"], paths: [], diff: "+new", exitCode: 0 },
    flags: [{ code: "changes", level: "info", detail: "changed=4" }],
    autoApproved: false, createdAt: new Date().toISOString(),
    ...over,
  };
}

function serve(...reqs: unknown[]) {
  api.get.mockResolvedValue({ success: true, data: reqs });
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset().mockResolvedValue({ success: true });
  confirmar.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

describe("aprobar sigue el protocolo", () => {
  // Roturas que atrapa: aceptar el nombre con otra caja, o ignorar una
  // bandera roja; y exigir algo de más a un change limpio.
  it("lo destructivo pide el nombre exacto, y una bandera roja pide reconocerse", () => {
    const red = [{ code: "touches-access", level: "red" as const }];
    expect(canApprove({ risk: "change", flags: [] }, "gstd", "", false)).toBe(true);
    expect(canApprove({ risk: "destructive", flags: [] }, "gstd", "", false)).toBe(false);
    expect(canApprove({ risk: "destructive", flags: [] }, "gstd", "GSTD", false)).toBe(false);
    expect(canApprove({ risk: "destructive", flags: [] }, "gstd", "gstd", false)).toBe(true);
    expect(canApprove({ risk: "change", flags: red }, "gstd", "", false)).toBe(false);
    expect(canApprove({ risk: "change", flags: red }, "gstd", "", true)).toBe(true);
    expect(canApprove({ risk: "change", flags: [{ code: "changes", level: "amber" as const }] }, "gstd", "", false)).toBe(true);
  });

  it("con una bandera roja, el botón espera a que se reconozca y manda la decisión entera", async () => {
    serve(request({ flags: [{ code: "touches-access", level: "red", detail: "/etc/ssh/sshd_config" }] }));
    render(<ProvisioningRequests server={server} canDecide />);
    const approve = await screen.findByRole("button", { name: en.approve });
    expect(disabled(approve)).toBe(true);
    expect(screen.getByText("/etc/ssh/sshd_config")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(disabled(approve)).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: en.note }), { target: { value: " simulacro " } });
    fireEvent.click(approve);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(confirmar).toHaveBeenCalledOnce();
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/servers/srv-1/provisioning-requests/rq-1/decision",
      { approve: true, note: "simulacro", confirmServer: "", acknowledgeFlags: true },
      true,
    );
  });

  it("si no se confirma, no se aprueba", async () => {
    confirmar.mockResolvedValueOnce(false);
    serve(request());
    render(<ProvisioningRequests server={server} canDecide />);
    fireEvent.click(await screen.findByRole("button", { name: en.approve }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("lo destructivo no se aprueba hasta escribir el nombre del servidor", async () => {
    serve(request({ playbook: "swarm-teardown", risk: "destructive", flags: [{ code: "destructive", level: "amber" }] }));
    render(<ProvisioningRequests server={server} canDecide />);
    const approve = await screen.findByRole("button", { name: en.approve });
    expect(disabled(approve)).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: en.typeServer.replace("{{name}}", "gstd") }), { target: { value: "gstd" } });
    expect(disabled(approve)).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    // Sin bandera roja no se marcó nada, y no se dice que se vio: si la
    // pantalla mandara siempre `true`, la comprobación del backend no
    // serviría de nada.
    expect(api.post.mock.calls[0][1]).toMatchObject({ approve: true, confirmServer: "gstd", acknowledgeFlags: false });
  });

  it("rechazar no pide confirmación", async () => {
    serve(request());
    render(<ProvisioningRequests server={server} canDecide />);
    fireEvent.click(await screen.findByRole("button", { name: en.reject }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(confirmar).not.toHaveBeenCalled();
    expect(api.post.mock.calls[0][1]).toMatchObject({ approve: false });
  });
});

// Una petición que se quedó sin ensayo decía «ensayando» hasta caducar (24 h)
// y no había forma de quitarla (gstd, 2-nov-2026).
describe("una petición que se quedó sin ensayo", () => {
  const old = () => new Date(Date.now() - STALE_CHECK_MS - 60_000).toISOString();
  const asMe = (id: string) => useAuthStore.setState({ session: { id } } as never);

  // Roturas que atrapa: dar por abandonado un ensayo que acaba de empezar, o
  // una petición que ya pasó del ensayo.
  it("es la que lleva un rato ensayando y nada más", () => {
    const now = Date.now();
    expect(isStale({ status: "checking", createdAt: new Date(now - STALE_CHECK_MS - 1).toISOString() }, now)).toBe(true);
    expect(isStale({ status: "checking", createdAt: new Date(now - 60_000).toISOString() }, now)).toBe(false);
    expect(isStale({ status: "awaiting_approval", createdAt: new Date(now - STALE_CHECK_MS * 10).toISOString() }, now)).toBe(false);
  });

  // Roturas que atrapa: seguir diciendo «ensayando»; no dejar descartarla a
  // quien la pidió; descartar sin confirmar, o a otra ruta.
  it("lo dice, y quien la pidió la descarta confirmando", async () => {
    asMe("u-1");
    serve(request({ status: "checking", check: null, flags: [], createdAt: old() }));
    render(<ProvisioningRequests server={server} canDecide={false} />);
    expect(await screen.findByText(en.staleBadge)).toBeTruthy();
    expect(screen.queryByText(en.status.checking)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en.discard }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(confirmar).toHaveBeenCalledOnce();
    expect(api.post).toHaveBeenCalledWith("/api/v1/servers/srv-1/provisioning-requests/rq-1/discard", {}, true);
  });

  it("si no se confirma, no se descarta", async () => {
    asMe("u-1");
    confirmar.mockResolvedValueOnce(false);
    serve(request({ status: "checking", check: null, flags: [], createdAt: old() }));
    render(<ProvisioningRequests server={server} canDecide={false} />);
    fireEvent.click(await screen.findByRole("button", { name: en.discard }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  // Roturas que atrapa: ofrecer descartar la de otro a un miembro; no
  // ofrecérselo a un admin; ofrecerlo mientras el ensayo sigue en marcha.
  it("la de otro sólo la descarta un admin, y una reciente nadie", async () => {
    asMe("u-otro");
    serve(request({ status: "checking", check: null, flags: [], createdAt: old() }));
    const { unmount } = render(<ProvisioningRequests server={server} canDecide={false} />);
    expect(await screen.findByText(en.staleBadge)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.discard })).toBeNull();
    unmount();
    render(<ProvisioningRequests server={server} canDecide />);
    expect(await screen.findByRole("button", { name: en.discard })).toBeTruthy();
    cleanup();
    asMe("u-1");
    serve(request({ status: "checking", check: null, flags: [] }));
    render(<ProvisioningRequests server={server} canDecide />);
    expect(await screen.findByText(en.status.checking)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.discard })).toBeNull();
  });
});

// Con todas a la vista, las descartadas y rechazadas de un simulacro empujaban
// el playbook fuera de la pantalla. Roturas que atrapa: esconder una abierta
// (algo espera a alguien); enseñar todas las cerradas; perder el orden; no
// poder verlas.
describe("la bandeja no se llena de lo cerrado", () => {
  const closed = (n: number) => Array.from({ length: n }, (_, i) => request({ id: `c-${i}`, status: i % 2 ? "discarded" : "rejected" }));
  it("enseña las abiertas y las últimas cerradas", () => {
    const all = [request({ id: "a-1", status: "awaiting_approval" }), ...closed(5), request({ id: "a-2", status: "approved" })] as never[];
    const { shown, hidden } = visibleRequests(all, false);
    expect(shown.map((r) => r.id)).toEqual(["a-1", "c-0", "c-1", "c-2", "a-2"]);
    expect(hidden).toBe(5 - RECENT_CLOSED);
    expect(visibleRequests(all, true).shown).toHaveLength(7);
  });

  it("las anteriores se ven al pedirlo", async () => {
    serve(...closed(5));
    render(<ProvisioningRequests server={server} canDecide />);
    await screen.findByTestId("request-c-0");
    expect(screen.queryByTestId("request-c-4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en.showOlder_other.replace("{{count}}", "2") }));
    expect(screen.getByTestId("request-c-4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.showFewer }));
    expect(screen.queryByTestId("request-c-4")).toBeNull();
  });
});

describe("lo que se ve", () => {
  it("quien no es admin no decide: ve quién lo hace", async () => {
    serve(request());
    render(<ProvisioningRequests server={server} canDecide={false} />);
    expect(await screen.findByText(en.adminDecides)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.approve })).toBeNull();
  });

  it("una autorizada enseña con qué se corre", async () => {
    serve(request({ status: "approved", grantExpiresAt: new Date(Date.now() + 600_000).toISOString() }));
    render(<ProvisioningRequests server={server} canDecide />);
    expect(await screen.findByText("cac provision run --server 'gstd' --grant rq-1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.approve })).toBeNull();
    // Un nombre con comilla no rompe el comando.
    expect(grantCommand("it's", "x")).toBe("cac provision run --server 'it'\\''s' --grant x");
  });

  // Un ensayo fallido dice qué tarea y por qué, sin abrir el log de nadie.
  // Roturas que atrapa: no enseñar los fallos; perder el mensaje; un ensayo
  // de antes (sin `failures` ni `logTail`) que rompe la fila.
  it("un ensayo fallido dice qué tarea falló y por qué, y deja ver el final de la salida", async () => {
    serve(
      request({
        flags: [{ code: "check-failed", level: "red" }],
        check: {
          hosts: ["gstd"], ok: 15, changed: 0, unreachable: 0, failed: 1, changedTasks: [], paths: [], diff: "", exitCode: 2,
          failures: [{ host: "gstd", task: "traefik : Registros DNS del servidor", message: "No zone found with name 76ceb04a" }],
          logTail: "TASK [x]\nfatal: [gstd]: FAILED!",
        },
      }),
      request({ id: "rq-2", check: { hosts: ["gstd"], ok: 1, changed: 0, unreachable: 0, failed: 0, changedTasks: [], paths: [], diff: "", exitCode: 0 } }),
    );
    render(<ProvisioningRequests server={server} canDecide />);
    const list = await screen.findByRole("list", { name: en.failures });
    expect(list.textContent).toContain("traefik : Registros DNS del servidor");
    expect(list.textContent).toContain("No zone found with name 76ceb04a");
    expect(screen.queryByText(/fatal: \[gstd\]/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en.showLog }));
    expect(screen.getByText(/fatal: \[gstd\]: FAILED!/)).toBeTruthy();
    expect(screen.getByTestId("request-rq-2")).toBeTruthy();
  });

  it("una respuesta con otra forma no rompe la pestaña", async () => {
    api.get.mockResolvedValue({ success: true, data: [{ id: 1 }, null, "x"] });
    const { container } = render(<ProvisioningRequests server={server} canDecide />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
