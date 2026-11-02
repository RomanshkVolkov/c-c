import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Lo que ya mordió, en el overview de un nodo y en la pantalla de un servidor
 * (command-and-control-289). Roturas que atrapa: pedir los de otro sitio (otra
 * ruta, sin el nodo o el servidor); pintar el título sin nada debajo; no
 * distinguir lo abierto de lo arreglado; no enseñar al desplegar los commits y
 * la prueba que lo guarda.
 */
const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

const { default: IncidentList } = await import("@/components/incidents/IncidentList");

const list = (incidents: unknown[]) => Promise.resolve({ success: true, data: { incidents } });

afterEach(() => {
  cleanup();
  get.mockReset();
});

describe("la lista de lo que mordió", () => {
  it("pide los del nodo y los del servidor a su ruta", async () => {
    get.mockReturnValue(list([]));
    render(<IncidentList node="l-back" />);
    render(<IncidentList serverId="srv 1" />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(get.mock.calls[0][0]).toBe("/api/v1/incidents/?node=l-back");
    expect(get.mock.calls[1][0]).toBe("/api/v1/servers/srv%201/incidents");
  });

  it("sin nada, en un overview no pinta ni el título; en el servidor lo dice", async () => {
    get.mockReturnValue(list([]));
    const { container } = render(<IncidentList node="l-back" heading />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.textContent).toBe("");
    cleanup();
    render(<IncidentList serverId="s" emptyHint />);
    expect(await screen.findByText(/record_incident/)).toBeTruthy();
  });

  it("marca lo abierto, y al abrir uno enseña su porqué, sus commits y su guardián", async () => {
    get.mockImplementation((path: string) =>
      path.includes("?node=")
        ? list([
            { id: "i1", title: "pixel-vps corre cert-manager 1.14", status: "open", servers: [{ id: "s", name: "pixel-vps" }], areas: ["cert-manager"], recordedAt: "2026-11-02T10:00:00Z" },
            { id: "i2", title: "ufw corta la red", status: "fixed", servers: [], areas: ["k8s"], recordedAt: "2026-11-02T10:00:00Z" },
          ])
        : Promise.resolve({
            success: true,
            data: {
              id: "i1", title: "x", status: "open", body: "El reto **no se limpia**.", servers: [], areas: [],
              createdAt: "2026-11-02T10:00:00Z", commits: [{ sha: "5397e32c0e52", url: "https://x/c", title: "fix(ansible)" }],
              guards: ["cert_manager_can_clean_its_cloudflare_challenge"], originRef: "cc-283", authorName: "Ana",
            },
          }),
    );
    render(<IncidentList node="l-back" heading />);
    const first = (await screen.findByText("pixel-vps corre cert-manager 1.14")).closest("article")!;
    const second = screen.getByText("ufw corta la red").closest("article")!;
    expect(first.getAttribute("data-status")).toBe("open");
    expect(second.getAttribute("data-status")).toBe("fixed");
    expect(first.textContent).toContain("pixel-vps");
    expect(first.textContent).toContain("cert-manager");
    fireEvent.click(first.querySelector("button")!);
    expect(await screen.findByText("cert_manager_can_clean_its_cloudflare_challenge")).toBeTruthy();
    expect(screen.getByText("5397e32").closest("a")!.getAttribute("href")).toBe("https://x/c");
    expect(first.textContent).toContain("no se limpia");
    expect(first.textContent).toContain("cc-283");
    expect(get).toHaveBeenLastCalledWith("/api/v1/incidents/i1", true);
  });
});
