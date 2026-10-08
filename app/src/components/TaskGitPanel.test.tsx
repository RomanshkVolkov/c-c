import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { GitSummary, TaskGitLink, TaskGitLinks } from "@/types/task";

/**
 * «Desarrollo»: lo que GitHub enlazó a una tarea.
 *
 * Que cada PR diga su estado, que los commits vengan plegados, y que sólo se
 * abra en el navegador lo que es de GitHub — los enlaces llegan por webhook.
 */

const openExternal = vi.fn(async (_u: string) => {});
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  openExternal: (u: string) => openExternal(u),
}));

const { default: TaskGitPanel, PrChip } = await import("@/components/TaskGitPanel");

afterEach(() => {
  cleanup();
  openExternal.mockClear();
});

const link = (x: Partial<TaskGitLink>): TaskGitLink => ({
  itemId: "t1",
  repoId: 1,
  repoFullName: "acme/web",
  kind: "pr",
  key: "1",
  title: "",
  htmlUrl: "",
  authorLogin: "",
  state: "",
  via: "text",
  occurredAt: "",
  ...x,
});

const git = (x: Partial<TaskGitLinks>): TaskGitLinks => ({
  summary: { branches: 0, prs: 0, commits: 0 },
  branches: [],
  prs: [],
  commits: [],
  ...x,
});

describe("el panel Desarrollo", () => {
  it("sin nada enlazado no se pinta", () => {
    const { container } = render(<TaskGitPanel git={git({})} />);
    expect(container.innerHTML).toBe("");
  });

  it("cada PR dice su estado", () => {
    render(
      <TaskGitPanel
        git={git({
          summary: { branches: 0, prs: 4, commits: 0 },
          prs: [
            link({ key: "1", title: "abre", state: "open" }),
            link({ key: "2", title: "borra", state: "draft" }),
            link({ key: "3", title: "fusiona", state: "merged" }),
            link({ key: "4", title: "cierra", state: "closed" }),
          ],
        })}
      />,
    );
    for (const [n, s] of [["1", "open"], ["2", "draft"], ["3", "merged"], ["4", "closed"]]) {
      const fila = screen.getByText(`#${n}`).closest("button")!;
      expect(fila.textContent).toContain(s);
    }
  });

  it("los commits vienen plegados", () => {
    render(
      <TaskGitPanel
        git={git({
          summary: { branches: 0, prs: 0, commits: 2 },
          commits: [link({ kind: "commit", key: "abcdef1234", title: "arregla el login\n\ncuerpo largo" })],
        })}
      />,
    );
    expect(screen.queryByText("arregla el login")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /2 commits/ }));
    // La primera línea del mensaje y el sha corto.
    expect(screen.getByText("arregla el login")).toBeTruthy();
    expect(screen.getByText("abcdef1")).toBeTruthy();
  });

  it("una rama borrada lo dice", () => {
    render(
      <TaskGitPanel
        git={git({
          summary: { branches: 1, prs: 0, commits: 0 },
          branches: [link({ kind: "branch", key: "cac-12-login", state: "deleted", via: "branch" })],
        })}
      />,
    );
    expect(screen.getByText("deleted")).toBeTruthy();
  });

  it("sólo abre en el navegador lo que es de GitHub", () => {
    render(
      <TaskGitPanel
        git={git({
          summary: { branches: 0, prs: 2, commits: 0 },
          prs: [
            link({ key: "1", htmlUrl: "https://github.com/acme/web/pull/1" }),
            link({ key: "2", htmlUrl: "https://otro.example/acme/web/pull/2" }),
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByText("#1").closest("button")!);
    fireEvent.click(screen.getByText("#2").closest("button")!);
    expect(openExternal.mock.calls).toEqual([["https://github.com/acme/web/pull/1"]]);
  });

  it("lo enlazado por la rama lo explica al pasar el ratón", () => {
    render(
      <TaskGitPanel
        git={git({ summary: { branches: 0, prs: 1, commits: 0 }, prs: [link({ key: "7", via: "branch" })] })}
      />,
    );
    expect(screen.getByText("#7").closest("button")!.getAttribute("title")).toBe("Linked by the branch name");
  });
});

describe("el chip de la tarjeta", () => {
  const chip = (g?: GitSummary) => render(<PrChip git={g} />).container;

  it("sin PRs no hay chip, aunque haya ramas y commits", () => {
    expect(chip({ branches: 2, prs: 0, commits: 5 }).innerHTML).toBe("");
    expect(chip(undefined).innerHTML).toBe("");
  });

  it("con PRs, cuántas y en qué estado", () => {
    const c = chip({ branches: 0, prs: 2, commits: 0, prBadge: "merged" });
    expect(c.textContent).toBe("2");
    expect(c.querySelector("span")!.getAttribute("title")).toBe("2 PRs · merged");
  });
});
