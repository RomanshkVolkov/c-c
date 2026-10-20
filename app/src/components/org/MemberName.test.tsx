import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import MemberName from "./MemberName";

/**
 * Quien no terminó el registro sale con su nombre y la marca de pendiente,
 * nunca con su usuario provisional. Mutante: pintar el usuario sin mirar
 * `setupPending`.
 */
afterEach(cleanup);

describe("el nombre de un miembro", () => {
  it("pendiente: su nombre y la marca, no el usuario provisional", () => {
    render(<MemberName member={{ userId: "u", username: "pending-0a1b2c3d4e5f", name: "Caro García", email: "caro@x.io", role: "member", setupPending: true }} />);
    expect(screen.getByText("Caro García")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/pending-0a1b/);
  });

  it("con el registro hecho: su usuario", () => {
    render(<MemberName member={{ userId: "u", username: "caro.g", name: "Caro", role: "member" }} />);
    expect(screen.getByText("@caro.g")).toBeTruthy();
    expect(screen.queryByText("Pending")).toBeNull();
  });
});
