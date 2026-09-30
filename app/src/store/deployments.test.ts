import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El historial de despliegues se **funde** con lo que llega del stream.
 *
 * El deploy lo hace el agente y lo va contando; la pantalla no vuelve a pedir
 * el historial en cada paso. Lo que se fija: una fila avanza sin perder quién
 * la pidió (el evento no trae el nombre), una nueva entra arriba, el log se
 * va sumando, y un evento que no se pudo leer no rompe nada.
 */

const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { post, get } }));

const { useDeploymentsStore } = await import("./deployments.store");
import type { Deployment } from "@/types/deploy";

const dep = (over: Partial<Deployment> = {}): Deployment =>
  ({
    id: "d-1", createdAt: "2026-09-30T10:00:00Z", deployableId: "dp-1", serverId: "srv-1",
    image: "ghcr.io/a/api:abc1234", finalImage: "", previousImage: "", requestedBy: "user",
    requestedByUserId: "u-ana", status: "queued", error: "", rollbackOfId: "",
    ...over,
  }) as Deployment;

beforeEach(() => {
  useDeploymentsStore.setState({ deployables: {}, history: {}, logs: {} });
  post.mockReset();
  get.mockReset();
});

describe("el historial y el stream", () => {
  it("una fila avanza sin perder quién la pidió", () => {
    useDeploymentsStore.setState({ history: { "dp-1": [dep({ requestedByName: "Ana López" })] } });
    useDeploymentsStore.getState().onStatus(dep({ status: "succeeded", finalImage: "ghcr.io/a/api:abc1234@sha256:ab" }));
    const [fila] = useDeploymentsStore.getState().history["dp-1"];
    expect(fila.status).toBe("succeeded");
    expect(fila.requestedByName).toBe("Ana López");
  });

  it("un deploy nuevo entra arriba", () => {
    useDeploymentsStore.setState({ history: { "dp-1": [dep({ id: "viejo", status: "succeeded" })] } });
    useDeploymentsStore.getState().onStatus(dep({ id: "nuevo" }));
    expect(useDeploymentsStore.getState().history["dp-1"].map((d) => d.id)).toEqual(["nuevo", "viejo"]);
  });

  it("el log se va sumando, y un evento vacío no toca nada", () => {
    const { onLog, onStatus } = useDeploymentsStore.getState();
    onLog({ deploymentId: "d-1", deployableId: "dp-1", lines: ["bajando"] });
    onLog({ deploymentId: "d-1", deployableId: "dp-1", lines: ["actualizando", "✓"] });
    expect(useDeploymentsStore.getState().logs["d-1"]).toBe("bajando\nactualizando\n✓\n");

    onStatus({} as Deployment);
    onLog({} as never);
    expect(useDeploymentsStore.getState().history).toEqual({});
    expect(Object.keys(useDeploymentsStore.getState().logs)).toEqual(["d-1"]);
  });

  it("desplegar manda el sha y deja la fila en el historial", async () => {
    post.mockResolvedValue({ success: true, data: dep() });
    await useDeploymentsStore.getState().deploy("srv-1", "dp-1", "abc1234");
    expect(post).toHaveBeenCalledWith("/api/v1/servers/srv-1/deployables/dp-1/deploy", { sha: "abc1234" }, true);
    expect(useDeploymentsStore.getState().history["dp-1"]).toHaveLength(1);
  });

  it("un error del servidor sale como error, con su frase", async () => {
    post.mockResolvedValue({ success: false, error: "Ya hay un deploy en cola" });
    await expect(useDeploymentsStore.getState().deploy("srv-1", "dp-1", "abc1234")).rejects.toThrow("Ya hay un deploy");
  });
});
