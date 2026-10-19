import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ItemCalendar from "@/components/ItemCalendar";
import { dayKey, toISODate } from "@/lib/month";
import { fecha } from "@/lib/fechas";

/**
 * El calendario del teléfono: mes compacto con puntos y, debajo, la lista del
 * día que se toca. El mes de escritorio no cabía (una tarea se leía «#14 p…»).
 */

const wide = window.innerWidth;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: wide });
});

const today = new Date();
const other = new Date(today.getFullYear(), today.getMonth(), today.getDate() === 15 ? 16 : 15);

const items = [
  { id: "a", title: "Revisar el backup de boaty", day: toISODate(today), dotClass: "bg-error", label: "#26" },
  { id: "b", title: "Logo nuevo", day: toISODate(other), dotClass: "bg-info", label: "#3" },
];

describe("el calendario en el teléfono", () => {
  const tap = (container: HTMLElement, d: Date) =>
    fireEvent.click(container.querySelector(`[data-day="${dayKey(d)}"]`)!);

  /**
   * Tocar un día sube una hoja con lo de ese día: no hay que bajar a buscarlo
   * y el mes no se mueve. El mutante que mata: pintar la lista debajo.
   */
  it("lo de un día, en una hoja al tocarlo", async () => {
    const { container } = render(<ItemCalendar items={items} onOpen={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    tap(container, today);
    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).toContain("Revisar el backup de boaty");
    expect(sheet.textContent).not.toContain("Logo nuevo");
    // Con el día como título, escrito para leerlo, no como clave.
    expect(screen.getByRole("heading", { name: fecha(today) })).toBeTruthy();
  });

  it("otro día, lo de ese día", async () => {
    const { container } = render(<ItemCalendar items={items} onOpen={() => {}} />);
    tap(container, other);
    expect((await screen.findByRole("dialog")).textContent).toContain("Logo nuevo");
  });

  it("un día sin nada lo dice", async () => {
    const empty = new Date(today.getFullYear(), today.getMonth(), today.getDate() === 20 ? 21 : 20);
    const { container } = render(<ItemCalendar items={[]} onOpen={() => {}} />);
    tap(container, empty);
    expect(await screen.findByText("Nothing this day")).toBeTruthy();
  });

  it("los días con algo llevan su punto de color", () => {
    const { container } = render(<ItemCalendar items={items} onOpen={() => {}} />);
    expect(container.querySelector("button[aria-pressed] .bg-error")).not.toBeNull();
  });

  it("abrir una tarea desde la hoja", async () => {
    const onOpen = vi.fn();
    const { container } = render(<ItemCalendar items={items} onOpen={onOpen} />);
    tap(container, today);
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(sheet.querySelector("button.bg-raised")!);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  /**
   * Bajo el mes, lo que viene desde hoy, en orden: lo primero que se quiere
   * saber, y el hueco que había ahí. Lo de ayer ya no es «próximo».
   */
  it("bajo el mes, lo próximo desde hoy y en orden", () => {
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const later = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3);
    render(
      <ItemCalendar
        items={[
          { id: "y", title: "De ayer", day: toISODate(yesterday), dotClass: "bg-info" },
          { id: "l", title: "En tres días", day: toISODate(later), dotClass: "bg-info" },
          { id: "t", title: "De hoy", day: toISODate(today), dotClass: "bg-info" },
        ]}
        onOpen={() => {}}
      />,
    );
    const section = screen.getByText("Coming up").parentElement!;
    expect(section.textContent).not.toContain("De ayer");
    expect(section.textContent!.indexOf("De hoy")).toBeLessThan(section.textContent!.indexOf("En tres días"));
  });

  /** Lo que no tiene fecha, detrás de una fila: cincuenta debajo del mes empujaban todo. */
  it("lo que no tiene fecha, en su propia hoja", async () => {
    render(<ItemCalendar items={[]} undated={[{ id: "u", title: "Sin fecha aún", dotClass: "bg-info" }]} onOpen={() => {}} />);
    expect(screen.queryByText("Sin fecha aún")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 with no date/ }));
    expect(await screen.findByText("Sin fecha aún")).toBeTruthy();
  });
});

describe("en escritorio", () => {
  it("sigue el mes grande", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    render(<ItemCalendar items={items} onOpen={() => {}} />);
    expect(screen.queryByText("Nothing this day")).toBeNull();
    expect(screen.getByRole("button", { name: "Today" })).toBeTruthy();
  });
});
