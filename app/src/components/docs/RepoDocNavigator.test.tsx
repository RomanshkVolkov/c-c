import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import RepoDocNavigator from "@/components/docs/RepoDocNavigator";
import { useRouteRequest } from "@/store/route-request.store";

/**
 * El navegador sigue una ruta pedida desde fuera del router, y la consume.
 * Mutantes: no seguir `useRouteRequest`; no consumirla (volvería a navegar).
 */
afterEach(cleanup);

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

describe("una ruta pedida desde fuera del router", () => {
  it("se sigue una vez", () => {
    const r = render(
      <MemoryRouter initialEntries={["/chat"]}>
        <RepoDocNavigator />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    act(() => useRouteRequest.getState().request("/docs"));
    expect(r.getByTestId("where").textContent).toBe("/docs");
    expect(useRouteRequest.getState().pending).toBeNull();
  });
});
