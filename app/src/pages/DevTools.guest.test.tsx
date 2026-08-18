import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * What the tool rail offers when nobody has signed in.
 *
 * Two of the three tools run entirely on the device, and they are the whole
 * point of guest mode. The third talks to the product like everything else.
 * Listing it to somebody who cannot use it is an invitation the app then
 * refuses at the door — so the rail leaves it out rather than showing it
 * greyed, and the route keeps its own gate underneath in case anybody arrives
 * by typing the address.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MemoryRouter, Routes, Route } = await import("react-router-dom");
const { default: DevTools } = await import("@/pages/DevTools");
const { useAuthStore } = await import("@/store/auth.store");

const montar = () =>
  render(
    <MemoryRouter initialEntries={["/devtools/image"]}>
      <Routes>
        <Route path="/devtools" element={<DevTools />}>
          <Route path="image" element={<div>herramienta</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

afterEach(cleanup);
beforeEach(() => {
  useAuthStore.setState({ accessToken: null } as never);
});

describe("el raíl de DevTools", () => {
  it("sin sesión ofrece sólo lo que funciona sin sesión", () => {
    montar();
    expect(screen.getByText("Image")).toBeTruthy();
    expect(screen.getByText("Tokens")).toBeTruthy();
    expect(screen.queryByText("Requests")).toBeNull();
  });

  it("con sesión ofrece las tres", () => {
    useAuthStore.setState({ accessToken: "t" } as never);
    montar();
    expect(screen.getByText("Image")).toBeTruthy();
    expect(screen.getByText("Requests")).toBeTruthy();
    expect(screen.getByText("Tokens")).toBeTruthy();
  });

  it("y el raíl se puede plegar, que es lo que lo hace usable en pantallas pequeñas", () => {
    montar();
    expect(screen.getByLabelText("Collapse the tool rail")).toBeTruthy();
  });
});
