import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * La actividad en la web: no hay pantalla de servidores, así que un despliegue
 * no enlaza a ella (sería una ruta que no existe, y un `/api/v1/servers` que la
 * sesión web tiene cerrado). El despliegue se sigue viendo. Mutante: dejar
 * cualquiera de los dos enlaces.
 */
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get } }));
vi.mock("@/lib/platform", () => ({ isTauri: false, isWeb: true, isWebBuild: true, openExternal: vi.fn() }));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: unknown) => unknown) => sel({ currentOrgId: "org-1" }),
}));

const { default: Activity } = await import("@/pages/Activity");

const dep = {
  id: "d-1", orgId: "org-1", createdAt: "2026-10-04T10:05:00Z", deployableId: "dp-1", serverId: "srv-1",
  image: "ghcr.io/dwit/api:abc1234", finalImage: "", previousImage: "", requestedBy: "github", requestedByUserId: "",
  status: "succeeded", error: "", rollbackOfId: "", deployableName: "api", deployableEnv: "prod", workflowRunId: "r-1",
};
const run = {
  id: "r-1", orgId: "org-1", repoId: 100, repoFullName: "dwit/api", runId: 9, runAttempt: 1, runNumber: 41,
  workflowName: "Deploy", path: ".github/workflows/prod.yml", event: "push", status: "completed", conclusion: "success",
  headSha: "abc1234def", headBranch: "main", commitTitle: "fix: el login", actor: "ana",
  htmlUrl: "https://github.com/dwit/api/actions/runs/9", occurredAt: "2026-10-04T10:00:00Z",
};

afterEach(cleanup);

describe("la actividad en la web", () => {
  it("los despliegues se ven, sin enlace a los servidores", async () => {
    get.mockResolvedValue({
      success: true,
      data: {
        items: [
          { kind: "run", at: run.occurredAt, run, deployments: [dep] },
          { kind: "deployment", at: dep.createdAt, deployment: dep },
        ],
        hasMore: false,
      },
    });
    const { container } = render(
      <MemoryRouter initialEntries={["/activity"]}>
        <Activity />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/→ api · prod/)).toBeTruthy();
    expect(screen.getAllByText("api").length).toBeGreaterThan(0);
    expect(container.querySelector('a[href^="/servers"]')).toBeNull();
  });
});
