import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Un enlace a algo de otra org cambia de org y lo abre ahí (decisión de jose,
 * 29-sep). Nunca se pinta algo de A dentro de B.
 *
 * Lo que importa es el **orden**: primero la org, después navegar. Cambiar de
 * org cierra lo que es de la de antes (`store/org-switch.ts`); al revés, lo
 * recién abierto sería lo que se cerrase.
 */

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

const { goInOrg, enterOrg } = await import("./ir-en-org");
const { useOrgsStore } = await import("@/store/orgs.store");

beforeEach(() => {
  toastError.mockClear();
  useOrgsStore.setState({
    orgs: [
      { id: "org-a", name: "A" },
      { id: "org-b", name: "B" },
    ],
    currentOrgId: "org-b",
  } as never);
});

describe("ir a algo en su org", () => {
  it("cambia de org antes de navegar", () => {
    let orgAlNavegar: string | null = null;
    const navigate = vi.fn(() => {
      orgAlNavegar = useOrgsStore.getState().currentOrgId;
    });
    expect(goInOrg(navigate, "/dm?c=c-1", "org-a")).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/dm?c=c-1");
    expect(orgAlNavegar).toBe("org-a");
  });

  it("en la misma org, sólo navega", () => {
    const setCurrentOrg = vi.spyOn(useOrgsStore.getState(), "setCurrentOrg");
    const navigate = vi.fn();
    goInOrg(navigate, "/tasks?task=t-1", "org-b");
    expect(navigate).toHaveBeenCalled();
    expect(setCurrentOrg).not.toHaveBeenCalled();
  });

  it("sin org (una nota), sólo navega", () => {
    const navigate = vi.fn();
    goInOrg(navigate, "/notes/n-1", undefined);
    expect(navigate).toHaveBeenCalledWith("/notes/n-1");
    expect(useOrgsStore.getState().currentOrgId).toBe("org-b");
  });

  it("a una org que no es tuya no va, y lo dice", () => {
    const navigate = vi.fn();
    expect(goInOrg(navigate, "/tasks?task=t-9", "org-ajena")).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(useOrgsStore.getState().currentOrgId).toBe("org-b");
    expect(toastError).toHaveBeenCalled();
  });

  it("enterOrg se pone en la org sin navegar", () => {
    expect(enterOrg("org-a")).toBe(true);
    expect(useOrgsStore.getState().currentOrgId).toBe("org-a");
  });
});
