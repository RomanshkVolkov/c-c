import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Aplicar un playbook desde la app.
 *
 * Lo que se fija:
 * 1. Lo que viaja a cac son **nombres**: ni el valor de una variable, ni la
 *    contraseña de sudo, ni lo leído de 1Password. Los valores sólo van a Rust.
 * 2. Lo que se lee de 1Password se manda a Rust como referencia, sin valor.
 * 3. Aplicar se confirma diciendo qué, contra qué y qué variables.
 * 4. Al acabar se cierra en cac con el resumen y la cola; parar es «parado».
 * 5. Sin lo obligatorio (una variable, la contraseña de sudo) no se aplica.
 * 6. Una ejecución que quedó a medias de antes se para y se cierra como
 *    interrumpida; una viva, al volver a la pestaña, no.
 */

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
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
vi.mock("./ServerLayout", () => ({
  useServerContext: () => ({ server: { id: "srv-1", name: "tds", host: "1.2.3.4", agentPort: 9090 } }),
}));

const { default: ServerProvision, live } = await import("./ServerProvision");
const { useProvisionStore } = await import("@/store/provision.store");

const manifest = {
  version: 1,
  venv: ".venv",
  inventory: "ansible/inventory.ini",
  discovered: false,
  playbooks: [
    {
      id: "tds", file: "ansible/playbooks/config-tds-rrhh.yml", name: "Configurar tds-rh", description: "", hosts: "tds",
      become: true, becomePasswordRef: null,
      vars: [
        { name: "deploy_public_key", description: "", from: "op://dwit/tds_deploy_user/public key", secret: false, required: true },
        { name: "api_token", description: "", from: null, secret: true, required: true },
      ],
    },
  ],
};

function tauri({ ansiblePlaybook = "/p/.venv/bin/ansible-playbook" as string | null } = {}) {
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "ansible_manifest":
        return manifest;
      case "ansible_tools":
        return { platformSupported: true, reason: "", ansiblePlaybook, op: "/usr/bin/op" };
      case "ansible_inventory":
        return [{ name: "tds-rh", groups: ["tds"], ansibleHost: "tds" }];
      case "ansible_run":
        return "run-1";
      case "ansible_cancel":
        return null;
    }
    throw new Error(`comando inesperado ${cmd}`);
  });
}

const SECRET = "valor-secreto-del-token";
const SUDO = "contraseña-de-sudo";

beforeEach(() => {
  channels.length = 0;
  live.runId = null;
  useProvisionStore.setState({ prefs: { "srv-1": { projectDir: "/p", limit: "", playbookId: "" } }, inFlight: null, lines: [], history: {} });
  api.get.mockReset().mockResolvedValue({ success: true, data: [] });
  api.post.mockReset().mockResolvedValue({ success: true, data: { id: "run-cac-1" } });
  api.patch.mockReset().mockResolvedValue({ success: true });
  confirmar.mockReset().mockResolvedValue(true);
  invoke.mockReset();
  tauri();
});
afterEach(cleanup);

const boton = () => screen.getByRole("button", { name: /^(aplicar|apply|aplicando…|applying…)$/i }) as HTMLButtonElement;

async function rellenar() {
  render(<ServerProvision />);
  await screen.findByLabelText("api_token *");
  fireEvent.change(screen.getByLabelText("api_token *"), { target: { value: SECRET } });
  fireEvent.change(screen.getByLabelText(/(contraseña de sudo|sudo password)/i), { target: { value: SUDO } });
}

describe("aplicar un playbook", () => {
  it("a cac van nombres; los valores y la contraseña sólo a Rust, y lo de 1Password como referencia", async () => {
    await rellenar();
    fireEvent.click(boton());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("ansible_run", expect.anything()));

    const body = api.post.mock.calls[0][1];
    expect(body).toEqual({
      kind: "playbook", project: "p", playbook: "ansible/playbooks/config-tds-rrhh.yml", target: "",
      varNames: ["deploy_public_key", "api_token"],
    });
    const spec = invoke.mock.calls.find((c) => c[0] === "ansible_run")![1].spec;
    expect(spec.vars).toEqual([
      { name: "deploy_public_key", from: "op://dwit/tds_deploy_user/public key", value: null, secret: false },
      { name: "api_token", from: null, value: SECRET, secret: true },
    ]);
    expect(spec.becomePassword).toBe(SUDO);

    // Lo que se confirma dice qué, contra qué y qué variables.
    expect(confirmar.mock.calls[0][0].description).toContain("deploy_public_key, api_token");

    // Al acabar, se cierra en cac con el resumen y la cola.
    act(() => {
      channels[0].onmessage!({ event: "line", data: { stream: "stdout", text: "PLAY RECAP ***" } });
      channels[0].onmessage!({ event: "line", data: { stream: "stdout", text: "tds-rh : ok=3 failed=0" } });
      channels[0].onmessage!({ event: "exit", data: { code: 0, cancelled: false } });
    });
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][0]).toBe("/api/v1/servers/srv-1/provisioning-runs/run-cac-1");
    expect(api.patch.mock.calls[0][1]).toMatchObject({ status: "succeeded", exitCode: 0, summary: "PLAY RECAP ***\ntds-rh : ok=3 failed=0" });

    // Ningún valor llegó a cac por ningún camino.
    const toCac = JSON.stringify([...api.post.mock.calls, ...api.patch.mock.calls]);
    expect(toCac).not.toContain(SECRET);
    expect(toCac).not.toContain(SUDO);
  });

  it("parar es «parado», no un fallo", async () => {
    await rellenar();
    fireEvent.click(boton());
    await waitFor(() => expect(channels).toHaveLength(1));
    act(() => channels[0].onmessage!({ event: "exit", data: { code: -15, cancelled: true } }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1].status).toBe("cancelled");
  });

  it("sin una variable obligatoria o sin la contraseña de sudo no se aplica", async () => {
    render(<ServerProvision />);
    await screen.findByLabelText("api_token *");
    // Cada una por separado: con la contraseña y sin la variable…
    fireEvent.change(screen.getByLabelText(/(contraseña de sudo|sudo password)/i), { target: { value: SUDO } });
    expect(boton().disabled).toBe(true);
    // …con las dos, sí; y sin la contraseña otra vez, no.
    fireEvent.change(screen.getByLabelText("api_token *"), { target: { value: SECRET } });
    expect(boton().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/(contraseña de sudo|sudo password)/i), { target: { value: "" } });
    expect(boton().disabled).toBe(true);
  });

  it("si no se confirma, no se apunta ni se corre nada", async () => {
    confirmar.mockResolvedValue(false);
    await rellenar();
    fireEvent.click(boton());
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("ansible_run", expect.anything());
  });

  it("cambiar de pestaña con una ejecución en marcha no la para", async () => {
    await rellenar();
    fireEvent.click(boton());
    await waitFor(() => expect(useProvisionStore.getState().inFlight?.runId).toBe("run-1"));
    cleanup();
    render(<ServerProvision />);
    await screen.findByLabelText("api_token *");
    expect(invoke).not.toHaveBeenCalledWith("ansible_cancel", expect.anything());
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("sin ansible-playbook lo dice y no se aplica", async () => {
    tauri({ ansiblePlaybook: null });
    await rellenar();
    expect(screen.getByText(/(no se encuentra ansible-playbook|ansible-playbook not found)/i)).toBeTruthy();
    expect(boton().disabled).toBe(true);
  });

  it("lo que quedó a medias de antes se para y se cierra como interrumpido", async () => {
    useProvisionStore.setState({ inFlight: { serverId: "srv-1", runId: "run-viejo", backendRunId: "cac-viejo" } });
    render(<ServerProvision />);
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("ansible_cancel", { runId: "run-viejo" });
    expect(api.patch.mock.calls[0][0]).toBe("/api/v1/servers/srv-1/provisioning-runs/cac-viejo");
    expect(api.patch.mock.calls[0][1].status).toBe("interrupted");
    expect(useProvisionStore.getState().inFlight).toBeNull();
  });

  it("una que sigue viva, al volver a la pestaña, no se toca", async () => {
    live.runId = "run-vivo";
    useProvisionStore.setState({ inFlight: { serverId: "srv-1", runId: "run-vivo", backendRunId: "cac-vivo" } });
    render(<ServerProvision />);
    await screen.findByLabelText("api_token *");
    expect(invoke).not.toHaveBeenCalledWith("ansible_cancel", expect.anything());
    expect(api.patch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^(parar|stop)$/i })).toBeTruthy();
  });
});
