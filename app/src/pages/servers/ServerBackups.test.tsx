import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { get, post, confirmar } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), confirmar: vi.fn() }));
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
