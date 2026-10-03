import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Los secrets de un servicio por referencia a 1Password.
 *
 * Lo que se fija:
 * 1. Rotar sólo en un servicio que despliega cac, confirmando con los nombres.
 * 2. A cac van nombres; los valores ni pasan por aquí (los lee Rust).
 * 3. Un fallo al rotar también se apunta, como fallo.
 * 4. Importar un ítem trae sus campos como referencias, sin pisar las que hay.
 * 5. Sólo un admin cambia de dónde salen; un viewer no rota.
 */

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
vi.mock("@/lib/api", () => ({ api }));
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { confirmar } = vi.hoisted(() => ({ confirmar: vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => confirmar }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const { default: ServiceSecretRefs, labelToName } = await import("./ServiceSecretRefs");
const { useDeploymentsStore } = await import("@/store/deployments.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useAuthStore } = await import("@/store/auth.store");

const server = { id: "srv-1", orgId: "org-1", name: "tds", host: "1.2.3.4", sshPort: 22, sshUser: "deploy", type: "docker-swarm", agentPort: 9090, status: "online" } as never;
const service = { id: "s1", name: "web-rrhh-prod_app", image: "x", stack: "web-rrhh-prod", replicas: { running: 1, desired: 1 }, updatedAt: "" } as never;
const deployable = (mode: "record" | "deploy") => ({
  id: "dp-1", orgId: "org-1", serverId: "srv-1", name: "app", stack: "web-rrhh-prod", serviceName: "web-rrhh-prod_app",
  imageRepo: "ghcr.io/x/y", environment: "prod", repoFullName: "", onCINotify: mode, ciKeyPreview: "", currentImage: "", previousImage: "",
});
const refs = [
  { name: "AUTH_SECRET", opRef: "op://dwit/Web RRHH/AUTH_SECRET" },
  { name: "DATABASE_URL", opRef: "op://dwit/Web RRHH/DATABASE_URL" },
];

function backend(mode: "record" | "deploy" | null, role: "admin" | "member" | "viewer" = "admin") {
  useOrgsStore.setState({ orgs: [{ id: "org-1", name: "Dwit", slug: "dwit", role, memberCount: 3 }] } as never);
  api.get.mockImplementation(async (url: string) => {
    if (url.endsWith("/deployables")) return { success: true, data: mode ? [deployable(mode)] : [] };
    if (url.endsWith("/secret-refs")) return { success: true, data: refs };
    if (url.endsWith("/secret-rotations")) return { success: true, data: [] };
    return { success: true, data: [] };
  });
}

beforeEach(() => {
  useDeploymentsStore.setState({ deployables: {}, history: {}, logs: {}, builds: {} });
  useAuthStore.setState({ session: { id: "u-1", username: "ana", superadmin: false } } as never);
  api.get.mockReset();
  api.put.mockReset().mockResolvedValue({ success: true, data: refs });
  api.post.mockReset().mockResolvedValue({ success: true, data: {} });
  invoke.mockReset();
  confirmar.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

const pintar = () => render(<ServiceSecretRefs server={server} service={service} />);
const botonRotar = () => screen.getByRole("button", { name: /(rotar en el servidor|rotate on the server)/i }) as HTMLButtonElement;

describe("los secrets de un servicio", () => {
  it("uno sin registrar lo dice", async () => {
    backend(null);
    pintar();
    await waitFor(() => expect(screen.getByText(/(no se despliega desde cac|isn't deployed from cac)/i)).toBeTruthy());
  });

  it("con el CI desplegando no se rota, y lo dice", async () => {
    backend("record");
    pintar();
    await waitFor(() => expect(screen.getAllByDisplayValue(/^op:\/\//)).toHaveLength(2));
    expect(botonRotar().disabled).toBe(true);
    expect(screen.getByText(/(tiraría estos secrets|silently drop these secrets)/i)).toBeTruthy();
  });

  it("rotar confirma con los nombres, lo hace Rust, y a cac van sólo nombres", async () => {
    backend("deploy");
    invoke.mockResolvedValue({
      items: [
        { name: "AUTH_SECRET", secret: "cac_AUTH_SECRET_0123456789abcdef", changed: false },
        { name: "DATABASE_URL", secret: "cac_DATABASE_URL_fedcba9876543210", changed: true },
      ],
      updated: true,
    });
    pintar();
    await waitFor(() => expect(botonRotar().disabled).toBe(false));
    fireEvent.click(botonRotar());
    await waitFor(() => expect(api.post).toHaveBeenCalled());

    expect(confirmar.mock.calls[0][0].description).toContain("AUTH_SECRET, DATABASE_URL");
    expect(invoke).toHaveBeenCalledWith("rotate_service_secrets", {
      target: { serverId: "srv-1", host: "1.2.3.4", sshPort: 22, sshUser: "deploy" },
      service: "web-rrhh-prod_app",
      refs,
    });
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/servers/srv-1/deployables/dp-1/secret-rotations",
      {
        names: ["AUTH_SECRET", "DATABASE_URL"],
        versions: { AUTH_SECRET: "cac_AUTH_SECRET_0123456789abcdef", DATABASE_URL: "cac_DATABASE_URL_fedcba9876543210" },
        status: "succeeded",
      },
      true,
    );
    await waitFor(() => expect(screen.getByText(/DATABASE_URL → cac_DATABASE_URL_fedcba9876543210/)).toBeTruthy());
  });

  it("si no se confirma, no se rota nada", async () => {
    backend("deploy");
    confirmar.mockResolvedValue(false);
    pintar();
    await waitFor(() => expect(botonRotar().disabled).toBe(false));
    fireEvent.click(botonRotar());
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("un fallo al rotar se apunta como fallo", async () => {
    backend("deploy");
    invoke.mockRejectedValue(new Error("DATABASE_URL: could not read secret"));
    pintar();
    await waitFor(() => expect(botonRotar().disabled).toBe(false));
    fireEvent.click(botonRotar());
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({ status: "failed", error: "DATABASE_URL: could not read secret" });
  });

  it("importar un ítem añade sus campos sin pisar los que hay, y guardar manda la lista", async () => {
    backend("deploy");
    invoke.mockResolvedValue([
      { label: "DATABASE_URL", opRef: "op://dwit/Web RRHH/DATABASE_URL" },
      { label: "mail host", opRef: "op://dwit/Web RRHH/mail host" },
    ]);
    pintar();
    await waitFor(() => expect(screen.getAllByDisplayValue(/^op:\/\//)).toHaveLength(2));
    fireEvent.change(screen.getByLabelText(/(ítem de 1password|1password item)/i), { target: { value: "op://dwit/Web RRHH" } });
    fireEvent.click(screen.getByRole("button", { name: /(importar campos|import fields)/i }));
    await waitFor(() => expect(screen.getAllByDisplayValue(/^op:\/\//)).toHaveLength(3));
    expect(invoke).toHaveBeenCalledWith("op_item_fields", { item: "op://dwit/Web RRHH" });
    expect(screen.getByDisplayValue("MAIL_HOST")).toBeTruthy();
    // Con cambios sin guardar no se rota: rotaría lo de antes.
    expect(botonRotar().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^(guardar|save)$/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1].refs.map((r: { name: string }) => r.name)).toEqual(["AUTH_SECRET", "DATABASE_URL", "MAIL_HOST"]);
  });

  it("un nombre que no vale no se guarda", async () => {
    backend("deploy");
    pintar();
    await waitFor(() => expect(screen.getAllByDisplayValue(/^op:\/\//)).toHaveLength(2));
    fireEvent.change(screen.getAllByLabelText(/^(nombre|name)$/i)[0], { target: { value: "auth secret" } });
    expect((screen.getByRole("button", { name: /^(guardar|save)$/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getAllByLabelText(/^(nombre|name)$/i)[0], { target: { value: "DATABASE_URL" } });
    expect((screen.getByRole("button", { name: /^(guardar|save)$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("un miembro rota pero no cambia de dónde salen; un viewer, ni eso", async () => {
    backend("deploy", "member");
    pintar();
    await waitFor(() => expect(botonRotar().disabled).toBe(false));
    expect(screen.queryByRole("button", { name: /^(guardar|save)$/i })).toBeNull();
    expect((screen.getAllByLabelText(/^(nombre|name)$/i)[0] as HTMLInputElement).disabled).toBe(true);
    cleanup();
    backend("deploy", "viewer");
    pintar();
    await waitFor(() => expect(screen.getAllByDisplayValue(/^op:\/\//)).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /(rotar en el servidor|rotate on the server)/i })).toBeNull();
  });

  it("una etiqueta se vuelve un nombre de secret", () => {
    expect(labelToName("mail host")).toBe("MAIL_HOST");
    expect(labelToName("DATABASE_URL")).toBe("DATABASE_URL");
    expect(labelToName("2fa-code")).toBe("_2FA_CODE");
  });
});
