import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { Deployable } from "@/types/deploy";
import type { Server } from "@/types/server";

/**
 * La rama del servicio y «Construir en el servidor».
 * Mutantes: mandar sólo lo de esta sección (borraría el resto de la fila, que
 * el PATCH pide entera); no avisar de un agente anterior a la v6; dejar
 * guardar el build sin repo.
 */

const { patch } = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { patch, get: vi.fn(), post: vi.fn() }, apiUrl: (p: string) => p }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: BuildOnHostSection } = await import("@/components/servers/BuildOnHostSection");

const server = (agentVersion: number) => ({ id: "srv-1", agentVersion }) as Server;
const deployable: Deployable = {
  id: "dp-1", orgId: "org-1", serverId: "srv-1", name: "boat", stack: "boat-prod", serviceName: "boat-prod_app",
  imageRepo: "ghcr.io/dwit-mexico/boat", environment: "prod", repoFullName: "dwit-mexico/boat",
  onCINotify: "deploy", ciKeyPreview: "", currentImage: "", previousImage: "",
  buildWorkflow: "prod.yml", shortTags: true, migrateCommand: "npx prisma migrate deploy",
};

beforeEach(() => {
  patch.mockReset();
  patch.mockImplementation(async (_url: string, body: object) => ({ success: true, data: { ...deployable, ...body } }));
});
afterEach(cleanup);

describe("rama y build", () => {
  it("guarda la rama y el build sin tocar lo demás del servicio", async () => {
    render(<BuildOnHostSection server={server(6)} deployable={deployable} />);
    fireEvent.change(screen.getByLabelText(/Branch it deploys/), { target: { value: "staging" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/Folder to build from/), { target: { value: "boat" } });
    fireEvent.click(screen.getByRole("button", { name: /Save branch and build/ }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [url, body] = patch.mock.calls[0];
    expect(url).toBe("/api/v1/servers/srv-1/deployables/dp-1");
    expect(body).toMatchObject({
      branch: "staging", buildOnHost: true, buildContext: "boat", dockerfile: "",
      // Lo de las otras secciones viaja igual: el PATCH pide la fila entera.
      buildWorkflow: "prod.yml", shortTags: true, migrateCommand: "npx prisma migrate deploy", onCINotify: "deploy",
    });
  });

  it("avisa si el agente no sabe construir, y no deja construir sin repo", () => {
    render(<BuildOnHostSection server={server(5)} deployable={{ ...deployable, buildOnHost: true }} />);
    expect(screen.getByText(/can't build: update it to v6/)).toBeTruthy();
    cleanup();
    render(<BuildOnHostSection server={server(6)} deployable={{ ...deployable, repoFullName: "" }} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/needs the service's repository/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save branch and build/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
