import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * La config de un servidor en cac, y aplicar con ella (manifiesto v2).
 *
 * Lo que se fija:
 * 1. Un secreto no sale de la pantalla como valor: una referencia que no es
 *    `op://` se para aquí, y lo que se guarda son nombres → referencias.
 * 2. Una config sin tocar no parece cambiada aunque Postgres devuelva las
 *    claves en otro orden.
 * 3. Una plantilla nace del manifiesto: sus defaults, los secretos que piden
 *    sus playbooks y la contraseña de sudo como de cada servidor.
 * 4. Aplicar es ensayar y pedir (el protocolo también en persona): abre la
 *    petición, ensaya con `--check` sin abrir ejecución y manda lo que cac
 *    evalúa; la plantilla se ensaya en orden y para en el primer ensayo que
 *    falla. Una autorizada se corre desde la bandeja con su autorización y
 *    después su verificación.
 * 5. Sin lo que pide el playbook (una variable, una referencia) no se aplica.
 */

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() } }));
vi.mock("@/lib/api", () => ({ api }));
const { invoke, channels } = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage?: (e: unknown) => void }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage?: (e: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const { confirmar } = vi.hoisted(() => ({ confirmar: vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => confirmar }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
const server = { id: "srv-1", orgId: "org-1", name: "gstd", host: "13.140.235.112", sshPort: 7337, sshUser: "infra_devops", agentPort: 9090 };
vi.mock("./ServerLayout", () => ({ useServerContext: () => ({ server }) }));

const { default: ServerProvision, live } = await import("./ServerProvision");
const { configBody, stableJson } = await import("./ServerConfigPanel");
const { templateFromManifest, orderedPlaybooks, stagePlaybooks } = await import("@/components/servers/ServerTemplateDialog");
const { varFields, fromInput, fromItems, toItems } = await import("@/components/servers/ansible-vars");
const { useProvisionStore } = await import("@/store/provision.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { pick } = await import("@/test-pick");
const manifestLoaded = () => invoke.mock.calls.some(([c]) => c === "ansible_tools");

const manifest = {
  version: 2,
  venv: ".venv",
  inventory: "",
  discovered: false,
  playbooks: [
    {
      id: "baseline", file: "playbooks/server-baseline.yml", name: "Etapa 1", description: "", hosts: "all",
      become: true, becomePasswordFrom: "OPS_PASSWORD", risk: "change", verify: "test", rollback: "manual",
      vars: [
        { name: "ops_user", description: "", secret: false, required: false, default: "infra_devops" },
        { name: "ssh_port", description: "", secret: false, required: true },
        { name: "ops_authorized_keys", description: "Las llaves.", secret: false, required: true, type: "list" },
        // Un default en un secreto lo rechaza Rust al leer el manifiesto; aquí,
        // por si acaso, tampoco pasa a la plantilla.
        { name: "ops_password", description: "", secret: true, required: false, from: "OPS_PASSWORD", default: "nunca" },
      ],
    },
    {
      id: "swarm", file: "playbooks/swarm-site.yml", name: "Etapa 2", description: "", hosts: "swarm",
      become: true, becomePasswordFrom: "OPS_PASSWORD", risk: "change", verify: "swarm-verify", rollback: "swarm-teardown",
      vars: [
        { name: "ops_user", description: "", secret: false, required: false, default: "otro" },
        { name: "traefik_image", description: "", secret: false, required: false, default: "traefik:v3.6" },
        { name: "public_ip", description: "La IP pública.", secret: false, required: true },
        { name: "dashboard_pass", description: "", secret: true, required: false, default: "nunca" },
        { name: "cloudflare_dns_token", description: "", secret: true, required: false, from: "CLOUDFLARE_DNS_TOKEN" },
      ],
    },
  ],
};

const effective = {
  serverId: "srv-1",
  configSeq: 3,
  templateId: "tpl-1",
  templateName: "Swarm + Traefik",
  templateSeq: 1,
  playbooks: ["baseline", "swarm"],
  vars: { base_domain: "gstd.guz-studio.dev", ssh_port: 7337 },
  opRefs: { OPS_PASSWORD: "op://Employee/gstd/password", CLOUDFLARE_DNS_TOKEN: "op://Employee/cf/credential" },
  requires: ["CLOUDFLARE_DNS_TOKEN", "OPS_PASSWORD"],
  perServer: ["OPS_PASSWORD"],
  missing: [],
  connection: { name: "gstd", host: "13.140.235.112", sshPort: 7337, sshUser: "infra_devops" },
};

const current = {
  id: "v3", serverId: "srv-1", seq: 3, templateId: "tpl-1", templateSeq: 1,
  // En el orden en que lo devuelve Postgres (jsonb: los cortos primero).
  vars: { ssh_port: 7337, base_domain: "gstd.guz-studio.dev" },
  opRefs: { OPS_PASSWORD: "op://Employee/gstd/password", CLOUDFLARE_DNS_TOKEN: "op://Employee/cf/credential" },
  createdBy: "u1", createdByName: "Ana", source: "app", note: "", createdAt: "2026-10-31T10:00:00Z",
};

let gaps = { vars: [] as string[], secrets: [] as string[] };
let requests: unknown[] = [];
const tplCurrent = {
  id: "tv1", templateId: "tpl-1", seq: 1, playbooks: ["baseline", "swarm"], vars: { traefik_image: "traefik:v3.7" },
  requires: ["CLOUDFLARE_DNS_TOKEN", "OPS_PASSWORD"], perServer: ["OPS_PASSWORD"], source: "app", note: "", createdAt: "2026-10-31T09:00:00Z",
};
const report = { hosts: ["gstd"], ok: 3, changed: 1, unreachable: 0, failed: 0, changedTasks: ["x"], paths: [], diff: "", exitCode: 0 };

function backend() {
  api.get.mockImplementation(async (path: string) => {
    if (path.includes("/config/effective")) return { success: true, data: effective };
    if (path.endsWith("/provisioning-requests")) return { success: true, data: requests };
    if (path.endsWith("/config")) return { success: true, data: { current, versions: [current] } };
    if (path.includes("/server-templates")) return { success: true, data: [{ id: "tpl-1", orgId: "org-1", name: "Swarm + Traefik", description: "", current: tplCurrent }] };
    if (path === "/api/v1/servers/") return { success: true, data: [server, { ...server, id: "srv-2", name: "dev" }] };
    return { success: true, data: [] };
  });
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "ansible_manifest":
        return manifest;
      case "ansible_tools":
        return { platformSupported: true, reason: "", ansiblePlaybook: "/p/.venv/bin/ansible-playbook", op: "/usr/bin/op" };
      case "ansible_plan_gaps":
        return gaps;
      case "ansible_run_with_config":
        return { runId: `run-${channels.length}`, varNames: [], target: "gstd" };
      case "ansible_check_report":
        return report;
      case "check_op_refs":
        return [{ opRef: "x", ok: true, error: "" }];
    }
    throw new Error(`comando inesperado ${cmd}`);
  });
}

beforeEach(() => {
  channels.length = 0;
  live.backendRunId = null;
  gaps = { vars: [], secrets: [] };
  requests = [];
  useProvisionStore.setState({ prefs: { "srv-1": { projectDir: "/p/infra/ansible", limit: "", playbookId: "swarm" } }, inFlight: null, lines: [], history: {} });
  useOrgsStore.setState({ orgs: [{ id: "org-1", name: "G", slug: "g", role: "admin" }] } as never);
  api.get.mockReset();
  api.post.mockReset().mockImplementation(async (path: string) => ({
    success: true,
    data: { id: path.endsWith("/provisioning-requests") ? `rq-${api.post.mock.calls.length}` : "run-cac" },
  }));
  api.patch.mockReset().mockResolvedValue({ success: true });
  api.put.mockReset().mockResolvedValue({ success: true, data: {} });
  confirmar.mockReset().mockResolvedValue(true);
  invoke.mockReset();
  backend();
});
afterEach(cleanup);

describe("las piezas puras", () => {
  // Rotura que atrapa: dejar pasar un valor pegado donde va la referencia.
  it("un secreto pegado en vez de su referencia no se guarda", () => {
    expect(configBody("", "{}", [{ name: "OPS_PASSWORD", ref: "hunter2-correct-horse" }], "")).toEqual({ error: "badRefs" });
    expect(configBody("", "{}", [{ name: "ops_password", ref: "op://v/i/f" }], "")).toEqual({ error: "badRefs" });
    expect(configBody("", "{}", [{ name: "A", ref: "op://v/i/f" }, { name: "A", ref: "op://v/i/g" }], "")).toEqual({ error: "badRefs" });
    expect(configBody("", "[1]", [], "")).toEqual({ error: "badJson" });
    // Un secreto que la plantilla pide y aún no tiene referencia se enseña
    // vacío: no se guarda, y no impide guardar lo demás.
    expect(configBody("", "{}", [{ name: "CLOUDFLARE_DNS_TOKEN", ref: "" }], "")).toEqual({ body: { templateId: "", vars: {}, opRefs: {}, note: "" } });
    expect(configBody("t", '{"a":1}', [{ name: "A", ref: " op://v/i/f " }, { name: "", ref: "" }], " por qué ")).toEqual({
      body: { templateId: "t", vars: { a: 1 }, opRefs: { A: "op://v/i/f" }, note: "por qué" },
    });
  });

  it("el JSON estable no depende del orden de las claves", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe(stableJson({ a: { c: [{ x: 2, y: 1 }], d: 2 }, b: 1 }));
  });

  // Roturas que atrapa: un secreto como default; que el segundo playbook pise
  // el default del primero; perder la de sudo como de cada servidor; el orden
  // de los playbooks según se marcaron y no según las etapas.
  it("una plantilla nace del manifiesto", () => {
    const tpl = templateFromManifest(manifest, ["baseline", "swarm"]);
    expect(tpl.vars).toEqual({ ops_user: "infra_devops", traefik_image: "traefik:v3.6" });
    expect(tpl.requires).toEqual(["CLOUDFLARE_DNS_TOKEN", "OPS_PASSWORD"]);
    expect(tpl.perServer).toEqual(["OPS_PASSWORD"]);
    expect(orderedPlaybooks(manifest, new Set(["swarm", "baseline"]))).toEqual(["baseline", "swarm"]);
  });
});

describe("el formulario en vez del JSON", () => {
  // Roturas que atrapa: un secreto como variable; perder una descripción que
  // trae otra etapa; la de sudo sin marcar; lo obligatorio no primero.
  it("las variables de unas etapas se leen como campos", () => {
    const f = varFields(manifest, ["baseline", "swarm"]);
    expect(f.shared.map((x) => [x.name, x.default])).toEqual([
      ["ops_user", "infra_devops"],
      ["traefik_image", "traefik:v3.6"],
    ]);
    expect(f.perServer.map((x) => x.name)).toEqual(["ssh_port", "ops_authorized_keys", "public_ip"]);
    expect(f.perServer[2].description).toBe("La IP pública.");
    expect(f.perServer.map((x) => x.list)).toEqual([false, true, false]);
    expect(f.secrets).toEqual([
      { name: "CLOUDFLARE_DNS_TOKEN", description: "", sudo: false },
      { name: "OPS_PASSWORD", description: "", sudo: true },
    ]);
  });

  // Roturas que atrapa: quedarse con la descripción vacía de la primera etapa
  // cuando otra la trae (o sin el tipo lista); no poner primero lo obligatorio.
  it("la descripción sale de la etapa que la tenga, y lo obligatorio va primero", () => {
    const v = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: "", secret: false, required: false, ...extra });
    const m = {
      ...manifest,
      playbooks: [
        { ...manifest.playbooks[0], id: "a", become: false, vars: [v("note"), v("tok", { secret: true, from: "TOK" }), v("keys")] },
        { ...manifest.playbooks[0], id: "b", become: false, vars: [v("domain", { required: true }), v("tok", { secret: true, from: "TOK", description: "El token." }), v("keys", { type: "list" })] },
      ],
    };
    const f = varFields(m, ["a", "b"]);
    expect(f.perServer.map((x) => x.name)).toEqual(["domain", "note", "keys"]);
    // Que otra etapa la declare lista también cuenta.
    expect(f.perServer[2].list).toBe(true);
    expect(f.secrets).toEqual([{ name: "TOK", description: "El token.", sudo: false }]);
  });

  // Roturas que atrapa: un puerto guardado como texto; un «0755» convertido
  // en número; una lista a medio escribir que se pierde; vacío guardado.
  it("lo escrito vuelve a su tipo", () => {
    expect(fromInput("7337")).toBe(7337);
    expect(fromInput("0755", "0644")).toBe("0755");
    expect(fromInput("[80, 443]", [80])).toEqual([80, 443]);
    expect(fromInput('["ssh-ed25519 A"]')).toEqual(["ssh-ed25519 A"]);
    expect(fromInput("[80,")).toBe("[80,");
    expect(fromInput("true")).toBe(true);
    expect(fromInput("  ")).toBeUndefined();
  });

  // Roturas que atrapa: una llave partida por sus espacios; una fila vacía
  // guardada como elemento; un puerto de la lista guardado como texto; una
  // lista vacía guardada; una lista vacía sin ninguna fila donde escribir.
  it("una lista son filas, una por elemento", () => {
    expect(fromItems(["ssh-ed25519 AAA jose@x", "", "  ssh-rsa BBB ci  "])).toEqual(["ssh-ed25519 AAA jose@x", "ssh-rsa BBB ci"]);
    expect(fromItems(["80", "443"], [80])).toEqual([80, 443]);
    expect(fromItems(["0755"])).toEqual(["0755"]);
    expect(fromItems([" ", ""])).toBeUndefined();
    expect(toItems(["a b", 2])).toEqual(["a b", "2"]);
    expect(toItems(undefined)).toEqual([""]);
    expect(toItems([])).toEqual([""]);
  });

  // Rotura que atrapa: ofrecer una verificación o un desmontaje como etapa.
  it("en una plantilla sólo se eligen etapas", () => {
    const m = { ...manifest, playbooks: [...manifest.playbooks, { ...manifest.playbooks[1], id: "swarm-verify", risk: "read" }, { ...manifest.playbooks[1], id: "swarm-teardown", risk: "destructive" }] };
    expect(stagePlaybooks(m).map((p) => p.id)).toEqual(["baseline", "swarm"]);
  });

  // Roturas que atrapa: nacer con todo marcado; no rellenar los defaults
  // solos; la de sudo compartida por defecto; no poder cambiarlo.
  it("una plantilla nueva empieza vacía y se rellena sola al elegir", async () => {
    render(<ServerProvision />);
    fireEvent.click(await screen.findByRole("button", { name: /nueva plantilla|new template/i }));
    const etapas = (await within(await screen.findByRole("dialog")).findAllByRole("checkbox")) as HTMLInputElement[];
    expect(etapas.every((c) => !c.checked)).toBe(true);
    fireEvent.change(screen.getByLabelText(/^(nombre|name)$/i), { target: { value: "Swarm" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /etapa 2/i }));
    expect((within(screen.getByRole("dialog")).getByLabelText("traefik_image") as HTMLInputElement).value).toBe("traefik:v3.6");
    await pick(screen.getByRole("combobox", { name: /CLOUDFLARE_DNS_TOKEN/ }), /cada servidor pone el suyo|each server sets its own/i);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /crear plantilla|create template/i })));
    const [path, body] = api.post.mock.calls.find(([p]) => String(p).includes("/server-templates/"))!;
    expect(path).toBe("/api/v1/organizations/org-1/server-templates/");
    expect(body).toMatchObject({
      name: "Swarm",
      playbooks: ["swarm"],
      vars: { ops_user: "otro", traefik_image: "traefik:v3.6" },
      requires: ["CLOUDFLARE_DNS_TOKEN", "OPS_PASSWORD"],
      perServer: ["CLOUDFLARE_DNS_TOKEN", "OPS_PASSWORD"],
    });
  });

  // Roturas que atrapa: imponer la IP del servidor sin que se pida; guardarla
  // mal; un puerto como texto; un secreto que falta guardado vacío.
  it("en el servidor, lo suyo se rellena con ayuda y lo que falta se ve", async () => {
    render(<ServerProvision />);
    const ip = (await screen.findByLabelText(/^public_ip/)) as HTMLInputElement;
    expect(ip.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /13\.140\.235\.112/ }));
    fireEvent.change(screen.getByLabelText(/^ssh_port/), { target: { value: "2222" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /guardar como versión nueva|save as a new version/i })));
    expect(api.put.mock.calls[0][1]).toMatchObject({ vars: { base_domain: "gstd.guz-studio.dev", public_ip: "13.140.235.112", ssh_port: 2222 } });
  });
});

// Roturas que atrapa: no poder agregar una segunda llave; que la fila
// recién agregada (vacía) desaparezca antes de escribir en ella; que Enter
// no abra la siguiente; quitar la que no es; guardarlas como un texto.
it("las llaves de un servidor son filas: se agregan con +, se quitan con × y se guardan como lista", async () => {
  render(<ServerProvision />);
  const first = (await screen.findByLabelText(/^ops_authorized_keys/)) as HTMLInputElement;
  expect(first.tagName).toBe("INPUT");
  fireEvent.change(first, { target: { value: "ssh-ed25519 AAA jose@x" } });
  fireEvent.click(screen.getByRole("button", { name: /agregar otra|add another/i }));
  fireEvent.change(screen.getByLabelText("ops_authorized_keys 2"), { target: { value: "ssh-rsa VIEJA" } });
  fireEvent.keyDown(screen.getByLabelText("ops_authorized_keys 2"), { key: "Enter" });
  fireEvent.change(screen.getByLabelText("ops_authorized_keys 3"), { target: { value: "ssh-ed25519 BBB ci" } });
  fireEvent.click(screen.getByRole("button", { name: /(quitar|remove) ops_authorized_keys 2/i }));
  expect(screen.queryByLabelText("ops_authorized_keys 3")).toBeNull();
  // Una fila vacía al final no se guarda.
  fireEvent.click(screen.getByRole("button", { name: /agregar otra|add another/i }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /guardar como versión nueva|save as a new version/i })));
  expect(api.put.mock.calls[0][1].vars.ops_authorized_keys).toEqual(["ssh-ed25519 AAA jose@x", "ssh-ed25519 BBB ci"]);
});

// Cada línea de la salida llamaba a `scrollIntoView`, que también desplaza la
// página: durante una ejecución te subía arriba (jose, 2-nov-2026). Roturas
// que atrapa: volver a desplazar la página; no seguir el final de la salida;
// arrastrar al final a quien subió a leer.
it("la salida sigue su final sin mover la página, y no arrastra a quien sube a leer", async () => {
  const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
  const had = proto.scrollIntoView;
  const intoView = vi.fn();
  proto.scrollIntoView = intoView;
  try {
    render(<ServerProvision />);
    const out = (await screen.findByLabelText(/salida de la ejecución|run output/i)) as HTMLPreElement;
    let top = 0;
    Object.defineProperty(out, "scrollHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(out, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(out, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
    act(() => useProvisionStore.setState({ lines: ["uno"] }));
    expect(top).toBe(500);
    top = 100;
    fireEvent.scroll(out);
    act(() => useProvisionStore.setState({ lines: ["uno", "dos"] }));
    expect(top).toBe(100);
    top = 400;
    fireEvent.scroll(out);
    act(() => useProvisionStore.setState({ lines: ["uno", "dos", "tres"] }));
    expect(top).toBe(500);
    expect(intoView).not.toHaveBeenCalled();
  } finally {
    proto.scrollIntoView = had;
  }
});

describe("la config del servidor", () => {
  it("sin tocar no hay nada que guardar, y lo guardado son referencias", async () => {
    render(<ServerProvision />);
    const guardar = (await screen.findByRole("button", { name: /guardar como versión nueva|save as a new version/i })) as HTMLButtonElement;
    await waitFor(() => expect((screen.getByLabelText(/variables \(json\)/i) as HTMLTextAreaElement).value).toContain("base_domain"));
    expect(guardar.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/variables \(json\)/i), { target: { value: '{"base_domain":"otro.dev","ssh_port":7337}' } });
    expect(guardar.disabled).toBe(false);
    await act(async () => fireEvent.click(guardar));
    expect(api.put).toHaveBeenCalledWith(
      "/api/v1/servers/srv-1/config",
      {
        templateId: "tpl-1",
        vars: { base_domain: "otro.dev", ssh_port: 7337 },
        opRefs: { CLOUDFLARE_DNS_TOKEN: "op://Employee/cf/credential", OPS_PASSWORD: "op://Employee/gstd/password" },
        note: "",
      },
      true,
    );
  });

  it("basar en otro servidor manda sólo de cuál, y se confirma", async () => {
    render(<ServerProvision />);
    const copiar = await screen.findByRole("button", { name: /copiar|copy/i });
    await pick(screen.getByRole("combobox", { name: /basar en otro|base it on/i }), "dev");
    // Diciendo que no, no se copia nada.
    confirmar.mockResolvedValueOnce(false);
    await act(async () => fireEvent.click(copiar));
    expect(api.put).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(copiar));
    expect(confirmar).toHaveBeenCalled();
    expect(api.put).toHaveBeenCalledWith("/api/v1/servers/srv-1/config", expect.objectContaining({ basedOnServerId: "srv-2" }), true);
  });

  it("quien no es admin la ve pero no la cambia", async () => {
    useOrgsStore.setState({ orgs: [{ id: "org-1", name: "G", slug: "g", role: "member" }] } as never);
    render(<ServerProvision />);
    await screen.findByLabelText(/variables \(json\)/i);
    expect(screen.queryByRole("button", { name: /guardar como versión nueva|save as a new version/i })).toBeNull();
  });
});

describe("aplicar con la config de cac", () => {
  const exit = async (i: number, code: number) => {
    await act(async () => channels[i].onmessage?.({ event: "line", data: { stream: "stdout", text: `PLAY RECAP ${i}` } }));
    await act(async () => channels[i].onmessage?.({ event: "exit", data: { code, cancelled: false } }));
  };
  const posts = (suffix: string) => api.post.mock.calls.filter(([p]) => String(p).endsWith(suffix));
  const runs = () => invoke.mock.calls.filter(([c]) => c === "ansible_run_with_config").map(([, a]) => a as { playbookId: string; check: boolean });

  // Roturas que atrapa: aplicar sin ensayar (check falso); abrir una
  // ejecución en cac por un ensayo; pedir sin el riesgo, su verify o su
  // versión; no mandar a cac lo que salió del ensayo; un valor en lo que viaja.
  it("aplicar es ensayar y pedir, y un ensayo no es una ejecución", async () => {
    render(<ServerProvision />);
    const ensayar = (await screen.findByRole("button", { name: /^(ensayar|rehearse)$/i })) as HTMLButtonElement;
    await waitFor(() => expect(ensayar.disabled).toBe(false));
    await act(async () => fireEvent.click(ensayar));

    expect(confirmar.mock.calls[0][0].description).toMatch(/3/);
    const [[, body]] = posts("/provisioning-requests");
    expect(body).toMatchObject({ playbook: "swarm", risk: "change", verify: "swarm-verify", rollback: "swarm-teardown", configSeq: 3 });
    expect(JSON.stringify(body)).not.toMatch(/op:\/\//);
    await waitFor(() => expect(channels.length).toBe(1));
    expect(runs()).toEqual([expect.objectContaining({ playbookId: "swarm", check: true, effective })]);

    await exit(0, 0);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/v1/servers/srv-1/provisioning-requests/rq-1/check", report, true));
    const read = invoke.mock.calls.find(([c]) => c === "ansible_check_report")!;
    expect(read[1]).toEqual({ lines: ["PLAY RECAP 0"], exitCode: 0 });
    expect(posts("/provisioning-runs")).toHaveLength(0);
  });

  // Un ensayo que no llega a arrancar (el secreto no se lee: el de gstd en la
  // otra cuenta de 1Password, 2-nov-2026) dejaba la petición «ensayando»
  // hasta caducar. Roturas que atrapa: no cerrarla; cerrarla como si hubiera
  // salido bien; perder el porqué; tragarse el error.
  it("un ensayo que no arranca cierra su petición como fallido, con el porqué", async () => {
    const why = "ops_password: could not read secret 'op://Private/x/password'";
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "ansible_run_with_config") throw new Error(why);
      return base(cmd, args);
    });
    render(<ServerProvision />);
    const ensayar = (await screen.findByRole("button", { name: /^(ensayar|rehearse)$/i })) as HTMLButtonElement;
    await waitFor(() => expect(ensayar.disabled).toBe(false));
    await act(async () => fireEvent.click(ensayar));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/v1/servers/srv-1/provisioning-requests/rq-1/check", report, true));
    expect(invoke.mock.calls.find(([c]) => c === "ansible_check_report")![1]).toEqual({ lines: [why], exitCode: -1 });
    const { toast } = await import("sonner");
    expect(toast.error).toHaveBeenCalledWith(why);
  });

  // Rotura que atrapa: seguir ensayando la etapa 2 cuando el ensayo de la 1
  // falló, o no seguir cuando salió bien.
  it("la plantilla se ensaya en orden y para en el primer ensayo que falla", async () => {
    render(<ServerProvision />);
    const plantilla = (await screen.findByRole("button", { name: /ensayar la plantilla|rehearse the template/i })) as HTMLButtonElement;
    await waitFor(() => expect(plantilla.disabled).toBe(false));
    await act(async () => fireEvent.click(plantilla));
    await waitFor(() => expect(channels.length).toBe(1));
    await exit(0, 2);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(runs().map((r) => r.playbookId)).toEqual(["baseline"]);

    channels.length = 0;
    await act(async () => fireEvent.click(plantilla));
    await waitFor(() => expect(channels.length).toBe(1));
    await exit(0, 0);
    await waitFor(() => expect(channels.length).toBe(2));
    expect(runs().map((r) => r.playbookId)).toEqual(["baseline", "baseline", "swarm"]);
    expect(runs().every((r) => r.check)).toBe(true);
  });

  // Roturas que atrapa: correr sin gastar la autorización (sin requestId, o
  // con el fichero en vez del id que casa el backend); saltarse la
  // verificación; correr la verificación cuando el playbook falló.
  it("una autorizada se corre desde la bandeja, con su autorización y después su verificación", async () => {
    requests = [
      {
        id: "rq-9", serverId: "srv-1", playbook: "swarm", project: "ansible", risk: "change", verify: "swarm-verify",
        rollback: "swarm-teardown", configSeq: 3, reason: "", requestedBy: "u1", source: "mcp", status: "approved",
        flags: [], autoApproved: false, createdAt: new Date().toISOString(), grantExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    ];
    render(<ServerProvision />);
    const correr = (await screen.findByRole("button", { name: /correr ahora|run now/i })) as HTMLButtonElement;
    await waitFor(() => expect(manifestLoaded()).toBe(true));
    await act(async () => fireEvent.click(correr));
    await waitFor(() => expect(channels.length).toBe(1));
    expect(api.get).toHaveBeenCalledWith("/api/v1/servers/srv-1/config/effective?seq=3", true);
    expect(posts("/provisioning-runs")[0][1]).toMatchObject({ playbook: "swarm", requestId: "rq-9", configSeq: 3 });
    expect(runs()).toEqual([expect.objectContaining({ playbookId: "swarm", check: false })]);

    await exit(0, 0);
    await waitFor(() => expect(channels.length).toBe(2));
    expect(posts("/provisioning-runs")[1][1]).toMatchObject({ playbook: "swarm-verify", requestId: "rq-9" });
    expect(runs().map((r) => r.playbookId)).toEqual(["swarm", "swarm-verify"]);
  });

  it("si el playbook falla, no se verifica; y si cambió su riesgo, no corre", async () => {
    requests = [
      {
        id: "rq-9", serverId: "srv-1", playbook: "swarm", project: "ansible", risk: "change", verify: "swarm-verify",
        rollback: "swarm-teardown", configSeq: 3, reason: "", requestedBy: "u1", source: "mcp", status: "approved",
        flags: [], autoApproved: false, createdAt: new Date().toISOString(),
      },
      {
        id: "rq-8", serverId: "srv-1", playbook: "baseline", project: "ansible", risk: "read", verify: "",
        rollback: "", configSeq: 3, reason: "", requestedBy: "u1", source: "mcp", status: "approved",
        flags: [], autoApproved: true, createdAt: new Date().toISOString(),
      },
    ];
    render(<ServerProvision />);
    const correr = (await screen.findAllByRole("button", { name: /correr ahora|run now/i }))[0];
    await waitFor(() => expect(manifestLoaded()).toBe(true));
    await act(async () => fireEvent.click(correr));
    await waitFor(() => expect(channels.length).toBe(1));
    await exit(0, 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(runs()).toHaveLength(1);

    // baseline es `change` en el manifiesto y se aprobó como `read`.
    // Mientras corre, la bandeja no ofrece correr: se vuelve a buscar.
    const otro = (await screen.findAllByRole("button", { name: /correr ahora|run now/i }))[1];
    confirmar.mockClear();
    await act(async () => fireEvent.click(otro));
    expect(confirmar).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(1);
    expect(posts("/provisioning-runs")).toHaveLength(1);
  });

  it("sin lo que pide el playbook no se aplica, y se dice qué falta", async () => {
    gaps = { vars: [], secrets: ["CLOUDFLARE_DNS_TOKEN"] };
    render(<ServerProvision />);
    await screen.findByText(/CLOUDFLARE_DNS_TOKEN/);
    const aplicar = screen.getByRole("button", { name: /^(ensayar|rehearse)$/i }) as HTMLButtonElement;
    expect(aplicar.disabled).toBe(true);
  });
});
