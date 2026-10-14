import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

import { pick } from "@/test-pick";

/**
 * El workflow se elige de los del repo cuando hay repo de la org; sin él, la
 * casilla de siempre. Mutantes: pedirlos sin repo; no conservar uno guardado
 * que ya no está.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get }, apiUrl: (p: string) => p }));

const { default: WorkflowField } = await import("@/components/servers/WorkflowField");

function Harness({ repo, start = "" }: { repo: string; start?: string }) {
  const [v, setV] = useState(start);
  return (
    <>
      <WorkflowField orgId="org-1" repo={repo} value={v} onChange={setV} />
      <output data-testid="value">{v}</output>
    </>
  );
}

afterEach(() => {
  cleanup();
  get.mockReset();
});

describe("el workflow del servicio", () => {
  it("con repo, se elige de los suyos", async () => {
    get.mockResolvedValue({ success: true, data: [{ file: "prod.yml", name: "Deploy" }, { file: "dev.yml", name: "Dev" }] });
    render(<Harness repo="Dwit-Mexico/web-boaty" />);
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/api/v1/organizations/org-1/github/workflows?repo=Dwit-Mexico%2Fweb-boaty", true),
    );
    await pick(await screen.findByLabelText(/workflow/i), /^dev\.yml/);
    expect(screen.getByTestId("value").textContent).toBe("dev.yml");
  });

  it("sin repo no pregunta, y uno guardado que ya no está se sigue viendo", async () => {
    render(<Harness repo="" />);
    await new Promise((r) => setTimeout(r, 400));
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("prod.yml")).toBeTruthy();
    cleanup();
    get.mockResolvedValue({ success: true, data: [{ file: "prod.yml", name: "Deploy" }] });
    render(<Harness repo="a/b" start="viejo.yml" />);
    const trigger = await screen.findByLabelText(/workflow/i);
    expect(trigger.textContent).toContain("viejo.yml");
    // Y está en la lista: se puede volver a él tras probar otro.
    fireEvent.click(trigger);
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toContain("viejo.yml");
  });
});
