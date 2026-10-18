import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { get, post, confirmar, invoke } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), confirmar: vi.fn(), invoke: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/api", () => ({ api: { get, post, patch: vi.fn(), delete: vi.fn() } }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => confirmar }));
vi.mock("@/pages/servers/ServerLayout", () => ({
  useServerContext: () => ({
    server: { id: "srv-1" },
    swarm: { services: [{ id: "s1", name: "sqlserver-prod_db", image: "mcr.microsoft.com/mssql/server:latest" }] },
  }),
}));

import ServerBackups from "@/pages/servers/ServerBackups";
import { useBackupsStore } from "@/store/backups.store";

const target = {
  id: "t1", serverId: "srv-1", serviceName: "sqlserver-prod_db", engine: "mssql", database: "boaty", credentialEnv: "MSSQL_SA_PASSWORD",
  everyHours: 24, anchorTime: "03:30", timezone: "UTC", keepDays: 7, keepWeekly: 4, keepMonthly: 6, restoreTestEveryDays: 7, enabled: true,
  lastSuccessAt: "2026-10-18T03:30:00Z",
};
const ok = <T,>(data: T) => ({ success: true, data });

beforeEach(() => {
  useBackupsStore.setState({ status: {}, targets: {}, recipients: {}, history: {}, logs: {} });
  get.mockImplementation((path: string) => {
    if (path.endsWith("/status")) return Promise.resolve(ok({ enabled: true, agentReady: true, agentVersion: 9, minAgent: 9, hasRecipients: true, everyHours: [24] }));
    if (path.endsWith("/targets")) return Promise.resolve(ok([target]));
    if (path.endsWith("/recipients")) return Promise.resolve(ok([{ id: "r1", label: "jose", publicKey: "age1x" }]));
    if (path.endsWith("/history")) return Promise.resolve(ok([{ id: "b1", targetId: "t1", kind: "scheduled", status: "succeeded", retentionClass: "monthly", sizeBytes: 60616704, error: "", createdAt: "2026-10-18T03:30:00Z" }]));
    return Promise.resolve(ok({}));
  });
  post.mockResolvedValue(ok({ url: "https://s3.test/x" }));
  confirmar.mockReset();
});
afterEach(cleanup);

/**
 * La pestaña Backups. Descargar se lleva una copia de la base de un cliente:
 * aunque vaya cifrada, se pregunta antes y un «no» no pide nada.
 * Mutantes: descargar sin preguntar; pedir la URL aunque digan que no.
 */
describe("la pestaña Backups", () => {
  // La primera vez no hay llaves ni bases, y el backend omite `data` en una
  // lista vacía. Mutante: tratar la falta de `data` como error (la pestaña
  // entera salía en rojo con «backups»).
  it("sin nada configurado enseña cómo empezar, no un error", async () => {
    get.mockImplementation((path: string) => {
      if (path.endsWith("/status")) return Promise.resolve(ok({ enabled: true, agentReady: true, agentVersion: 9, minAgent: 9, hasRecipients: false, everyHours: [24] }));
      return Promise.resolve({ success: true });
    });
    render(<ServerBackups />);
    expect(await screen.findByText(/^(llaves de cifrado|encryption keys)$/i)).toBeTruthy();
    expect(await screen.findByText(/(todavía no se respalda|no database is backed up)/i)).toBeTruthy();
    expect(screen.queryByText(/^backups$/)).toBeNull();
  });

  it("enseña la base y su historial, y descargar pide confirmación", async () => {
    render(<ServerBackups />);
    expect(await screen.findByText("boaty")).toBeTruthy();
    const descargar = await screen.findByRole("button", { name: /^(descargar|download)$/i });

    confirmar.mockResolvedValue(false);
    fireEvent.click(descargar);
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/download"), expect.anything(), true);

    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    confirmar.mockResolvedValue(true);
    fireEvent.click(descargar);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/backups/runs/b1/download", {}, true));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://s3.test/x", "_blank", "noopener"));
  });
});

const PUB = "age1uzcuhrh6yezjg96efqkks530nnrtmea9q89m87pawfqdckp8h9yqf9yvjy";

/**
 * Crear la llave en 1Password: la app la crea con la cuenta y la bóveda
 * elegidas, y aquí sólo se registra la pública, con un nombre que dice dónde
 * vive la privada.
 * Mutantes: no pasar la cuenta (con dos cuentas, `op` elige por su cuenta);
 * registrarla sin decir la bóveda.
 */
describe("crear la llave en 1Password", () => {
  it("la crea en la bóveda elegida y registra sólo la pública", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "op_list_vaults") return Promise.resolve([{ account: "my.1password.com", email: "jose@x", vault: "Private" }]);
      if (cmd === "create_backup_key") return Promise.resolve({ item: "op://Private/cac backups – llave age", publicKey: PUB });
      return Promise.reject(new Error(cmd));
    });
    post.mockImplementation((_path: string, body: { label: string; publicKey: string }) =>
      Promise.resolve(ok({ id: "r2", label: body.label, publicKey: body.publicKey })),
    );
    render(<ServerBackups />);
    fireEvent.click(await screen.findByRole("button", { name: /(crear llave en 1password|create key in 1password)/i }));
    const crear = await screen.findByRole("button", { name: /^(crear|create)$/i });
    await waitFor(() => expect((crear as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(crear);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("create_backup_key", { account: "my.1password.com", vault: "Private", title: "cac backups – llave age" }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/servers/srv-1/backups/recipients",
        { label: "cac backups – llave age (1Password · Private)", publicKey: PUB },
        true,
      ),
    );
  });
});

/**
 * Cada campo del formulario dice qué es y da un ejemplo (jose, 18-oct-2026:
 * «no entiendo qué hacen algunos inputs»).
 * Mutantes: quitar el ejemplo del «?»; dejar un campo sin su ayuda en algún
 * idioma.
 */
describe("la ayuda del formulario", () => {
  it("el «?» de Base explica el campo y da un ejemplo", async () => {
    render(<ServerBackups />);
    fireEvent.click(await screen.findByRole("button", { name: /^(añadir base|add database)$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^(ayuda|help): (base|database)$/i }));
    expect(await screen.findByText(/(explorador de bases|database explorer)/i)).toBeTruthy();
    expect(screen.getByText(/^(ejemplo|example):/i).textContent).toMatch(/boaty/);
  });

  it("todos los campos tienen su ayuda en los dos idiomas", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const keys = ["engine", "service", "database", "credentialEnv", "every", "at", "timezone", "keepDays", "keepWeekly", "keepMonthly", "restoreEvery", "enabled"];
    for (const lang of ["en", "es"]) {
      const help = JSON.parse(readFileSync(join(process.cwd(), "src/locales", lang, "common.json"), "utf-8")).backups.help;
      for (const k of keys) {
        expect(help[k]?.text, `${lang}: ${k}`).toBeTruthy();
      }
    }
  });
});

/**
 * La retención se dice como frase: a qué se puede volver. Y cambia al tocar
 * los números. Mutantes: no quitar las semanas al ponerlas a 0; un resumen
 * fijo que no sigue al formulario.
 */
describe("el resumen de la retención", () => {
  it("dice a qué se puede volver y sigue a los números", async () => {
    render(<ServerBackups />);
    fireEvent.click(await screen.findByRole("button", { name: /^(añadir base|add database)$/i }));
    const summary = await screen.findByTestId("retention-summary");
    expect(summary.textContent).toMatch(/(cualquier día de los últimos 7|any day in the last 7)/);
    expect(summary.textContent).toMatch(/(cualquier semana de las últimas 4|any week in the last 4)/);
    expect(summary.textContent).toMatch(/(cualquier mes de los últimos 6|any month in the last 6)/);

    const weeks = screen.getAllByRole("spinbutton")[1];
    fireEvent.change(weeks, { target: { value: "0" } });
    expect(screen.getByTestId("retention-summary").textContent).not.toMatch(/(semana|week)/);
  });
});

/**
 * Probar la restauración a mano avisa antes de que puede hacer lenta la base,
 * y un «no» no la lanza. Mutante: lanzarla sin preguntar.
 */
describe("probar la restauración a mano", () => {
  it("avisa del impacto y un no no la lanza", async () => {
    render(<ServerBackups />);
    const probar = await screen.findByRole("button", { name: /(probar restauración|test restore)/i });
    confirmar.mockResolvedValue(false);
    fireEvent.click(probar);
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(JSON.stringify(confirmar.mock.calls[0][0])).toMatch(/(más lenta|slower)/);
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/test"), expect.anything(), true);
  });
});
