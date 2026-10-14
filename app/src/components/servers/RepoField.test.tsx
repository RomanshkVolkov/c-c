import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

/**
 * El repo de un servicio se elige de los que ve la GitHub App de la org.
 * Mutantes: no filtrar por lo escrito; avisar de un repo que sí ve (con otras
 * mayúsculas); no avisar de uno que no ve; sin App, quitar la casilla.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get }, apiUrl: (p: string) => p }));

const { default: RepoField } = await import("@/components/servers/RepoField");

const status = (configured: boolean, repos: string[]) => ({
  success: true,
  data: { configured, installations: [], repos: repos.map((fullName, i) => ({ id: `r${i}`, fullName })) },
});

function Harness({ start = "" }: { start?: string }) {
  const [v, setV] = useState(start);
  return (
    <>
      <RepoField orgId="org-1" value={v} onChange={setV} />
      <output data-testid="value">{v}</output>
    </>
  );
}

afterEach(cleanup);

describe("el repo de un servicio", () => {
  it("se busca entre los de la App y se elige", async () => {
    get.mockResolvedValue(status(true, ["Dwit-Mexico/web-boaty", "Dwit-Mexico/api-rrhh", "RomanshkVolkov/c-c"]));
    render(<Harness />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/organizations/org-1/github/", true));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "boaty" } });
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Dwit-Mexico/web-boaty"]);
    fireEvent.click(options[0]);
    expect(screen.getByTestId("value").textContent).toBe("Dwit-Mexico/web-boaty");
    expect(screen.queryByText(/doesn't see this repository/)).toBeNull();
  });

  it("avisa de un repo que la App no ve, no de uno con otras mayúsculas", async () => {
    get.mockResolvedValue(status(true, ["Dwit-Mexico/web-boaty"]));
    render(<Harness start="dwit-mexico/web-boaty" />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    expect(screen.queryByText(/doesn't see this repository/)).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "dwit-mexico/boat" } });
    expect(screen.getByText(/doesn't see this repository/)).toBeTruthy();
  });

  it("sin la App, es una casilla de texto", async () => {
    get.mockResolvedValue(status(false, []));
    render(<Harness />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const input = screen.getByPlaceholderText("owner/repo");
    fireEvent.change(input, { target: { value: "a/b" } });
    expect(screen.getByTestId("value").textContent).toBe("a/b");
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
