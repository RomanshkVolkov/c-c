import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error } }));

import { Reactions } from "./Reactions";

/**
 * Las pastillas de un mensaje. Mutantes: pulsar la mía la vuelve a poner en vez
 * de quitarla; pulsar la de otro no suma; no marcar cuál es mía; no decir
 * quiénes; callar si el servidor falla; pintar una fila vacía.
 */
afterEach(cleanup);

describe("las reacciones de un mensaje", () => {
  it("sin ninguna no ocupa sitio", () => {
    const { container } = render(<Reactions reactions={[]} onReact={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("la mía se quita y la de otro suma la mía; quiénes, al pasar el ratón", () => {
    const onReact = vi.fn(async () => {});
    render(
      <Reactions
        reactions={[
          { emoji: "👍", count: 2, mine: true, names: ["Bea", "Ana"] },
          { emoji: "🎉", count: 1, mine: false, names: ["Bea"] },
        ]}
        onReact={onReact}
      />,
    );
    const [pulgar, fiesta] = screen.getAllByRole("button", { pressed: undefined }).filter((b) =>
      b.hasAttribute("aria-pressed"),
    );
    expect(pulgar.getAttribute("aria-pressed")).toBe("true");
    expect(fiesta.getAttribute("aria-pressed")).toBe("false");
    expect(pulgar.getAttribute("title")).toBe("Bea, Ana");
    expect(pulgar.textContent).toContain("2");

    fireEvent.click(pulgar);
    expect(onReact).toHaveBeenLastCalledWith("👍", false);
    fireEvent.click(fiesta);
    expect(onReact).toHaveBeenLastCalledWith("🎉", true);
  });

  it("si el servidor dice que no, se avisa", async () => {
    error.mockClear();
    render(
      <Reactions
        reactions={[{ emoji: "👍", count: 1, mine: false, names: ["Bea"] }]}
        onReact={() => Promise.reject(new Error("502"))}
      />,
    );
    fireEvent.click(screen.getAllByRole("button").find((b) => b.hasAttribute("aria-pressed"))!);
    await waitFor(() => expect(error).toHaveBeenCalled());
  });
});

/**
 * El menú para elegir reacción es una fila de ocho, con su propio ancho. El
 * menú base toma el del botón que lo abre (un icono de 20 px), y con eso los
 * emojis quedaban apilados en una columna estrecha encima del mensaje
 * (18-oct-2026). El mutante que mata: quitar `w-auto`.
 */
describe("el menú para reaccionar", () => {
  it("no toma el ancho del botón que lo abre", async () => {
    const { ReactionPicker } = await import("./Reactions");
    render(<ReactionPicker onReact={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "React" }));
    const menu = await screen.findByRole("menu");
    expect(menu.className).toContain("w-auto");
    expect(menu.className).not.toContain("w-(--anchor-width)");
  });
});
