import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
 * 4. Aplicar con la config de cac apunta la versión, lanza en Rust con la
 *    efectiva (sin valores) y, con la plantilla, corre la secuencia y para en
 *    la primera que falla.
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
const { templateFromManifest, orderedPlaybooks } = await import("@/components/servers/ServerTemplateDialog");
const { useProvisionStore } = await import("@/store/provision.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { pick } = await import("@/test-pick");

const manifest = {
  version: 2,
  venv: ".venv",
  inventory: "",
  discovered: false,
  playbooks: [
    {
      id: "baseline", file: "playbooks/server-baseline.yml", name: "Etapa 1", description: "", hosts: "all",
      become: true, becomePasswordFrom: "OPS_PASSWORD",
      vars: [
        { name: "ops_user", description: "", secret: false, required: false, default: "infra_devops" },
        { name: "ssh_port", description: "", secret: false, required: true },
        // Un default en un secreto lo rechaza Rust al leer el manifiesto; aquí,
        // por si acaso, tampoco pasa a la plantilla.
        { name: "ops_password", description: "", secret: true, required: false, from: "OPS_PASSWORD", default: "nunca" },
      ],
    },
    {
      id: "swarm", file: "playbooks/swarm-site.yml", name: "Etapa 2", description: "", hosts: "swarm",
      become: true, becomePasswordFrom: "OPS_PASSWORD",
      vars: [
        { name: "ops_user", description: "", secret: false, required: false, default: "otro" },
        { name: "traefik_image", description: "", secret: false, required: false, default: "traefik:v3.6" },
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

function backend() {
  api.get.mockImplementation(async (path: string) => {
    if (path.endsWith("/config/effective")) return { success: true, data: effective };
    if (path.endsWith("/config")) return { success: true, data: { current, versions: [current] } };
    if (path.includes("/server-templates")) return { success: true, data: [{ id: "tpl-1", orgId: "org-1", name: "Swarm + Traefik", description: "", current: null }] };
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
  useProvisionStore.setState({ prefs: { "srv-1": { projectDir: "/p/infra/ansible", limit: "", playbookId: "swarm" } }, inFlight: null, lines: [], history: {} });
  useOrgsStore.setState({ orgs: [{ id: "org-1", name: "G", slug: "g", role: "admin" }] } as never);
  api.get.mockReset();
  api.post.mockReset().mockResolvedValue({ success: true, data: { id: "run-cac" } });
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
    await act(async () => channels[i].onmessage?.({ event: "exit", data: { code, cancelled: false } }));
  };

  // Roturas que atrapa: no apuntar la versión; mandar a Rust otra cosa que la
  // efectiva; un valor en lo que viaja a cac.
  it("apunta la versión y lanza con la efectiva", async () => {
    render(<ServerProvision />);
    const aplicar = (await screen.findByRole("button", { name: /^(aplicar|apply)$/i })) as HTMLButtonElement;
    await waitFor(() => expect(aplicar.disabled).toBe(false));
    await act(async () => fireEvent.click(aplicar));

    expect(confirmar.mock.calls[0][0].description).toMatch(/3/);
    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe("/api/v1/servers/srv-1/provisioning-runs");
    expect(body).toMatchObject({ kind: "playbook", playbook: "playbooks/swarm-site.yml", target: "gstd", configSeq: 3 });
    expect(JSON.stringify(body)).not.toMatch(/op:\/\//);
    const run = invoke.mock.calls.find(([c]) => c === "ansible_run_with_config")!;
    expect(run[1]).toMatchObject({ projectDir: "/p/infra/ansible", playbookId: "swarm", effective });
  });

  // Rotura que atrapa: seguir con la etapa 2 cuando la 1 falló.
  it("la plantilla corre en orden y para en la primera que falla", async () => {
    render(<ServerProvision />);
    const plantilla = (await screen.findByRole("button", { name: /aplicar la plantilla|apply the template/i })) as HTMLButtonElement;
    await waitFor(() => expect(plantilla.disabled).toBe(false));
    await act(async () => fireEvent.click(plantilla));
    await waitFor(() => expect(channels.length).toBe(1));
    expect(invoke.mock.calls.filter(([c]) => c === "ansible_run_with_config").map(([, a]) => (a as { playbookId: string }).playbookId)).toEqual(["baseline"]);

    await exit(0, 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke.mock.calls.filter(([c]) => c === "ansible_run_with_config")).toHaveLength(1);

    // Y si la 1 acaba bien, sigue con la 2.
    channels.length = 0;
    await act(async () => fireEvent.click(plantilla));
    await waitFor(() => expect(channels.length).toBe(1));
    await exit(0, 0);
    await waitFor(() => expect(channels.length).toBe(2));
    expect(invoke.mock.calls.filter(([c]) => c === "ansible_run_with_config").map(([, a]) => (a as { playbookId: string }).playbookId)).toEqual([
      "baseline",
      "baseline",
      "swarm",
    ]);
  });

  it("sin lo que pide el playbook no se aplica, y se dice qué falta", async () => {
    gaps = { vars: [], secrets: ["CLOUDFLARE_DNS_TOKEN"] };
    render(<ServerProvision />);
    await screen.findByText(/CLOUDFLARE_DNS_TOKEN/);
    const aplicar = screen.getByRole("button", { name: /^(aplicar|apply)$/i }) as HTMLButtonElement;
    expect(aplicar.disabled).toBe(true);
  });
});
