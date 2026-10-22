import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * La clave de un espacio en su menú (cac#203): se ve, y se cambia con un
 * PATCH al espacio que lleva `key`.
 */

const { patch } = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), patch, delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MemoryRouter } = await import("react-router-dom");
const { default: SpacesNavigator } = await import("@/components/tree/SpacesNavigator");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { useTasksStore } = await import("@/store/tasks.store");

const espacio = { id: "sp-1", orgId: "org-1", name: "Proteus", key: "proteus", color: "#888888", folders: [], lists: [] };

const montar = () =>
  render(
    <MemoryRouter>
      <ConfirmProvider>
        <PromptProvider>
          <SpacesNavigator />
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

afterEach(cleanup);
beforeEach(() => {
  patch.mockReset();
  patch.mockResolvedValue({ success: true });
  useTasksStore.setState({ tree: [espacio], loadingTree: false, error: null } as never);
});

describe("la clave del espacio", () => {
  // Roturas que detectan: no enseñar la clave en el menú; o cambiarla sin
  // mandar `key` (sólo se renombraría), o sin el nombre, que el PATCH pide.
  it("se ve en el menú y se cambia con el PATCH del espacio", async () => {
    montar();
    fireEvent.click(screen.getByLabelText(/space menu|menú del espacio/i));
    fireEvent.click(await screen.findByRole("menuitem", { name: /proteus$/ }));
    const input = await screen.findByDisplayValue("proteus");
    fireEvent.change(input, { target: { value: "pocna" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/v1/task-spaces/sp-1", { name: "Proteus", key: "pocna" }, true));
  });

  // Una sala sin clave (la general, o un backend de antes) no ofrece cambiarla.
  it("sin clave, no hay entrada", async () => {
    useTasksStore.setState({ tree: [{ ...espacio, key: undefined }], loadingTree: false, error: null } as never);
    montar();
    fireEvent.click(screen.getByLabelText(/space menu|menú del espacio/i));
    await screen.findByRole("menuitem", { name: /rename|renombrar/i });
    expect(screen.queryByRole("menuitem", { name: /^(Key|Clave):/ })).toBeNull();
  });
});
