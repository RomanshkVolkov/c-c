import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ItemCalendar, { type CalendarEntry, type CalendarItem } from "@/components/ItemCalendar";
import { dueCalendarItems } from "@/components/tasks/due-calendar";
import { fecha } from "@/lib/fechas";

/**
 * Un mes que se lee de un vistazo.
 *
 * Lo que había antes: cada día pintaba puntos de seis píxeles y un número en la
 * esquina, y el título sólo aparecía si acertabas a hacer clic en ese día. Con
 * una sola tarea en todo el mes, la pantalla entera decía «1» — costaba
 * encontrarlo, y encontrado no decía **qué** era.
 *
 * Estas pruebas fijan lo contrario: que el título esté ahí sin pulsar nada, que
 * se pueda abrir de un clic, y que lo que no cabe se anuncie en vez de
 * desaparecer.
 */

// Fijado a un día concreto: «hoy» se pinta distinto, y una prueba que dependa
// de la fecha real fallaría sola dentro de un mes.
const TODAY = new Date(2026, 7, 26);

// El dato que produce la app: un día, sin hora ni zona. Antes se fabricaba
// `new Date(2026, 7, dia, 10, 0).toISOString()` —local y a las diez de la
// mañana—, que da la vuelta redonda en cualquier zona y por eso nunca vio que
// un vencimiento de verdad (medianoche UTC) caía el día anterior.
const item = (id: string, dayOfMonth: number, extra: Partial<CalendarEntry> = {}): CalendarItem => ({
  id,
  title: `tarea ${id}`,
  day: `2026-08-${String(dayOfMonth).padStart(2, "0")}`,
  dotClass: "bg-primary",
  ...extra,
});

const renderCalendar = (items: CalendarItem[], onOpen = vi.fn()) => {
  vi.setSystemTime(TODAY);
  render(<ItemCalendar items={items} onOpen={onOpen} countKey="common:count.tasks" />);
  return onOpen;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("lo que se ve sin pulsar nada", () => {
  it("el título está en el día, no escondido tras un clic", () => {
    vi.useFakeTimers();
    renderCalendar([item("a", 29, { title: "pensar en ideas de contenido" })]);
    expect(screen.getByText("pensar en ideas de contenido")).toBeTruthy();
  });

  it("con su etiqueta delante, que es la hora o el folio", () => {
    vi.useFakeTimers();
    renderCalendar([item("a", 29, { label: "#2" })]);
    expect(screen.getByText("#2")).toBeTruthy();
  });

  // Varios el mismo día se leen todos, no se resumen en un número.
  it("tres el mismo día se leen los tres", () => {
    vi.useFakeTimers();
    renderCalendar([item("a", 12), item("b", 12), item("c", 12)]);
    expect(screen.getByText("tarea a")).toBeTruthy();
    expect(screen.getByText("tarea b")).toBeTruthy();
    expect(screen.getByText("tarea c")).toBeTruthy();
  });
});

describe("abrir uno", () => {
  it("se abre de un clic, sin pasar por el día", () => {
    vi.useFakeTimers();
    const onOpen = renderCalendar([item("a", 29, { title: "abrir esto" })]);
    fireEvent.click(screen.getByText("abrir esto"));
    expect(onOpen).toHaveBeenCalledWith("a");
  });
});

describe("cuando no caben", () => {
  // Un día con seis cosas no puede leerse como un día con tres.
  it("dice cuántos faltan", () => {
    vi.useFakeTimers();
    renderCalendar([item("a", 12), item("b", 12), item("c", 12), item("d", 12), item("e", 12)]);
    expect(screen.getByText("+2 more")).toBeTruthy();
  });

  it("y al pulsarlo salen todos", () => {
    vi.useFakeTimers();
    renderCalendar([item("a", 12), item("b", 12), item("c", 12), item("d", 12)]);
    expect(screen.queryByText("tarea d")).toBeNull();
    fireEvent.click(screen.getByText("+1 more"));
    expect(screen.getByText("tarea d")).toBeTruthy();
  });

  it("con tres o menos no sobra nada que anunciar", () => {
    vi.useFakeTimers();
    renderCalendar([item("a", 12), item("b", 12), item("c", 12)]);
    expect(screen.queryByText(/more$/)).toBeNull();
  });
});

describe("hoy", () => {
  // Antes lo más llamativo de la pantalla era el día **seleccionado**, con un
  // borde grueso; hoy sólo cambiaba de color. Lo que orienta es hoy.
  it("se marca con un círculo relleno", () => {
    vi.useFakeTimers();
    renderCalendar([]);
    const cell = screen.getAllByText("26").find((e) => e.className.includes("rounded-full"));
    expect(cell?.className).toContain("bg-primary");
  });

  it("y los demás días no", () => {
    vi.useFakeTimers();
    renderCalendar([]);
    const other = screen.getAllByText("27").find((e) => e.className.includes("rounded-full"));
    expect(other?.className ?? "").not.toContain("bg-primary");
  });
});

/**
 * El día que alguien eligió, se mire desde donde se mire.
 *
 * jose, en Querétaro (UTC−6), soltó una tarea en el 30 de septiembre y se pintó
 * en el 29. Lo guardado estaba bien —`2026-09-30T00:00:00.000Z`—; lo que fallaba
 * era leerlo con captadores locales. Ninguna prueba lo vio porque vitest corría
 * en la zona de la máquina y el fixture esquivaba la forma del dato.
 *
 * Estas pruebas tienen que pasar en cualquier zona (`bun run test:timezones`), y
 * sólo matan a su mutante al oeste de Greenwich, que es donde corre `test`.
 */
describe("en qué día cae", () => {
  const SEPTEMBER = new Date(2026, 8, 15);

  /** El número del día en cuya celda está `titulo`. */
  const dayOf = (title: string) =>
    screen
      .getByText(title)
      .closest("div")
      ?.querySelector("span.rounded-full")?.textContent;

  it("un vencimiento a medianoche UTC cae en su día, no en el anterior", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SEPTEMBER);
    render(
      <ItemCalendar
        items={dueCalendarItems([
          { id: "a", seq: 1, title: "entregar", priority: "none", dueAt: "2026-09-30T00:00:00.000Z" },
        ])}
        onOpen={vi.fn()}
      />,
    );
    expect(dayOf("entregar")).toBe("30");
  });

  // Lo contrario también es verdad, y es por lo que no vale «pasarlo todo a
  // UTC»: una reunión es un instante, y cae en el día de quien la mira.
  it("un instante cae en el día local de quien mira", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SEPTEMBER);
    const at = "2026-09-30T02:00:00.000Z"; // el 29 a las 20:00 en Querétaro
    render(
      <ItemCalendar
        items={[{ id: "r", title: "reunión", at, dotClass: "bg-primary" }]}
        onOpen={vi.fn()}
      />,
    );
    expect(dayOf("reunión")).toBe(String(new Date(at).getDate()));
  });

  it("el rótulo del día abierto dice el día elegido", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SEPTEMBER);
    const dueAt = "2026-09-30T00:00:00.000Z";
    render(
      <ItemCalendar
        items={dueCalendarItems(
          ["a", "b", "c", "d"].map((id, i) => ({ id, seq: i, title: id, priority: "none", dueAt })),
        )}
        onOpen={vi.fn()}
        countKey="common:count.tasks"
      />,
    );
    fireEvent.click(screen.getByText("+1 more"));
    const chosen = `${fecha(new Date(2026, 8, 30))} ·`;
    expect(screen.getByText((text) => text.startsWith(chosen))).toBeTruthy();
  });
});
