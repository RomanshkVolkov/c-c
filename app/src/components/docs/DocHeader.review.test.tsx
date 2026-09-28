import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { Doc } from "@/types/task";

/**
 * Una revisión pedida se ve en el doc, junto a la frescura, hasta que alguien
 * firma (#92).
 *
 * Aquí y no sólo en la campana a propósito: si el aviso se pierde, la petición
 * no puede perderse con él.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(() => Promise.resolve({ success: true, data: [] })), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { default: DocHeader } = await import("@/components/docs/DocHeader");
const { PromptProvider } = await import("@/components/PromptDialog");

const doc = (extra: Partial<Doc> = {}): Doc =>
  ({
    id: "d", orgId: "org-1", ownerKind: "list", ownerId: "l", body: "",
    updatedAt: "2026-09-27T10:00:00Z", stale: false, ...extra,
  }) as Doc;

const montar = (d: Doc) =>
  render(
    <PromptProvider>
      <DocHeader doc={d} />
    </PromptProvider>,
  );

afterEach(cleanup);

describe("una revisión pedida", () => {
  /** El mutante que mata: quitar el chip. */
  it("se ve, con quién la pidió y lo que hay que mirar", () => {
    montar(doc({
      reviewRequestedAt: "2026-09-28T09:00:00Z",
      reviewRequestedByName: "bot",
      reviewRequestNote: "Cambié la sección de correo.",
    }));
    const chip = screen.getByTestId("review-requested");
    expect(chip.textContent).toContain("bot");
    // La nota va en el título: es lo que dice por dónde empezar.
    expect(chip.getAttribute("title")).toBe("Cambié la sección de correo.");
  });

  /** Y cuando ya se firmó —o nunca se pidió—, no hay nada que enseñar. */
  it("no se ve si no hay ninguna pendiente", () => {
    montar(doc());
    expect(screen.queryByTestId("review-requested")).toBeNull();
  });

  /** Sin nombre no se deja un hueco: la frase sigue diciéndose entera. */
  it("sin nombre de quien la pidió, dice «alguien»", () => {
    montar(doc({ reviewRequestedAt: "2026-09-28T09:00:00Z" }));
    expect(screen.getByTestId("review-requested").textContent).toContain("someone");
  });
});
