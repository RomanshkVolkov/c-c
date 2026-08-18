import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * A quién se ofrece buscar, según para qué.
 *
 * El servidor da dos respuestas distintas: acotado a una organización devuelve
 * colegas **incluido quien pregunta**; sin acotar devuelve la plataforma entera
 * y deja fuera a quien pregunta —porque ese buscador es el de invitar, y uno no
 * se invita—. El selector mandaba siempre la segunda, así que en el detalle de
 * una tarea no podías asignártela a ti mismo.
 */

const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/store/users.store", () => ({
  useUsersStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ search }),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ currentOrgId: "org-1" }),
}));

const { default: UserPicker } = await import("@/components/UserPicker");

beforeEach(() => {
  search.mockClear();
  search.mockResolvedValue([]);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const teclear = async (scope: "org" | "platform") => {
  render(<UserPicker scope={scope} onSelect={() => {}} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "jo" } });
  await vi.advanceTimersByTimeAsync(300);
  await waitFor(() => expect(search).toHaveBeenCalled());
  return search.mock.calls[search.mock.calls.length - 1];
};

describe("a quién ofrece el selector", () => {
  it("para asignar, busca entre colegas — que es donde estás tú", async () => {
    expect(await teclear("org")).toEqual(["jo", "org-1"]);
  });

  it("para invitar, busca en toda la plataforma", async () => {
    expect(await teclear("platform")).toEqual(["jo", undefined]);
  });
});
