import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * La sala general no sale en el navegador de tareas.
 *
 * Es un espacio como los demás para el chat y para la llamada, pero **no tiene
 * trabajo dentro**: ni listas, ni carpetas, y el servidor rechaza que se las
 * cuelguen. Pintarla aquí sería ofrecer «New list» sobre algo que va a
 * responder que no, que es justo lo que el usuario no quería —tener que
 * mantener un espacio con su maquinaria para poder tener una sala.
 *
 * Se filtra **en la pantalla y no en el store**: la sala tiene que seguir en el
 * árbol para que la barra de la llamada sepa su nombre y para que Channels la
 * pinte. Por eso la prueba mira lo que se ve, con el store de verdad cargado.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MemoryRouter } = await import("react-router-dom");
const { default: SpacesNavigator } = await import("@/components/tree/SpacesNavigator");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { useTasksStore } = await import("@/store/tasks.store");

const trabajo = {
  id: "sp-1",
  orgId: "org-1",
  name: "Ingeniería",
  color: "#888888",
  folders: [],
  lists: [{ id: "li-1", name: "Pendientes", taskCount: 0 }],
};

const sala = {
  id: "sp-g",
  orgId: "org-1",
  name: "General",
  color: "",
  kind: "general",
  folders: [],
  lists: [],
};

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
  useTasksStore.setState({ tree: [trabajo, sala], loadingTree: false, error: null } as never);
});

describe("la sala general en el navegador de tareas", () => {
  it("no se pinta", () => {
    montar();
    expect(screen.queryByText("General")).toBeNull();
  });

  it("y los espacios de trabajo sí", () => {
    montar();
    expect(screen.getByText("Ingeniería")).toBeTruthy();
  });

  // Con la sala en el árbol y nada más, el navegador está vacío **de trabajo**:
  // decir «no hay espacios» es lo correcto, y contarla haría que la pantalla
  // pareciera tener algo que no tiene.
  it("una organización con sólo la sala sigue sin espacios", () => {
    useTasksStore.setState({ tree: [sala], loadingTree: false, error: null } as never);
    montar();
    expect(screen.getByText(/No spaces yet/)).toBeTruthy();
  });

  // Y sigue en el store: es lo que le permite a la barra de la llamada saber
  // cómo se llama la sala en la que estás, y a Channels anclarla arriba.
  it("pero sigue en el árbol, que es de dónde la lee la llamada", () => {
    montar();
    expect(useTasksStore.getState().tree.some((s) => s.kind === "general")).toBe(true);
  });
});
