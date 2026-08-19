import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * Un fallo tiene que decir qué pasó y dejar rastro.
 *
 * Lo que había: «Could not load this task.» y un botón de cerrar. Ni el motivo,
 * ni el id, ni una tarjeta en ninguna parte — así estuvo una semana un reporte
 * de cliente que no aterrizaba en ningún tablero, y sólo se supo cuando una
 * notificación apuntó a él.
 */

const { fileCrash, estado } = vi.hoisted(() => ({
  fileCrash: vi.fn(),
  estado: {
    current: {
      openTaskId: "item-99",
      detail: null as unknown,
      loadingDetail: false,
      detailError: null as string | null,
      closeTask: () => {},
    },
  },
}));

vi.mock("@/lib/file-crash", () => ({
  fileCrash,
  signature: (t: string) => `crash-${t}`,
  rutaActual: () => "/tasks",
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel(estado.current as unknown as Record<string, unknown>),
}));
// El cuerpo del drawer no se monta en estos casos; sus dependencias sí pesan.
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));
vi.mock("@/components/markdown/Markdown", () => ({ default: () => null }));
vi.mock("@/components/UserPicker", () => ({ default: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/PromptDialog", () => ({ usePrompt: () => async () => "" }));

const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");

beforeEach(() => {
  fileCrash.mockResolvedValue("done");
  estado.current = {
    openTaskId: "item-99",
    detail: null,
    loadingDetail: false,
    detailError: null,
    closeTask: () => {},
  };
});
afterEach(cleanup);

describe("cuando una tarjeta no abre", () => {
  it("enseña el motivo del servidor, no un texto muerto", async () => {
    estado.current.detailError = "list not found";
    render(<TaskDetailDrawer />);
    // El motivo es lo único con lo que se puede buscar el fallo.
    expect(await screen.findByText("list not found")).toBeTruthy();
    expect(screen.queryByText("Could not load this task.")).toBeNull();
  });

  it("levanta la tarjeta en cac, con la firma del motivo", async () => {
    estado.current.detailError = "list not found";
    render(<TaskDetailDrawer />);
    await waitFor(() => expect(fileCrash).toHaveBeenCalledTimes(1));
    const arg = fileCrash.mock.calls[0][0];
    // Del motivo y no del id: cuarenta reportes rotos por lo mismo son un
    // problema, no cuarenta tarjetas.
    expect(arg.key).toBe("crash-detail-failed: list not found");
    expect(arg.description).toContain("item-99");
  });

  it("no ficha dos veces el mismo fallo", async () => {
    estado.current.detailError = "list not found";
    const { rerender } = render(<TaskDetailDrawer />);
    await waitFor(() => expect(fileCrash).toHaveBeenCalledTimes(1));
    rerender(<TaskDetailDrawer />);
    rerender(<TaskDetailDrawer />);
    expect(fileCrash).toHaveBeenCalledTimes(1);
  });

  /**
   * Y tampoco bajo StrictMode, que monta, desmonta y vuelve a montar.
   *
   * Es el único caso donde el guarda por `ref` hace algo que las dependencias
   * del efecto no hacen ya — y la app corre con StrictMode puesto, así que en
   * desarrollo cada fallo levantaría dos tarjetas sin él.
   */
  it("ni bajo StrictMode", async () => {
    estado.current.detailError = "list not found";
    render(
      <StrictMode>
        <TaskDetailDrawer />
      </StrictMode>,
    );
    await waitFor(() => expect(fileCrash).toHaveBeenCalled());
    expect(fileCrash).toHaveBeenCalledTimes(1);
  });
});
