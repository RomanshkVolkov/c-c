import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ItemCalendar, { type CalendarItem } from "@/components/ItemCalendar";

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
const HOY = new Date(2026, 7, 26);

const item = (id: string, dia: number, extra: Partial<CalendarItem> = {}): CalendarItem => ({
  id,
  title: `tarea ${id}`,
  at: new Date(2026, 7, dia, 10, 0).toISOString(),
  dotClass: "bg-primary",
  ...extra,
});

const pintar = (items: CalendarItem[], onOpen = vi.fn()) => {
  vi.setSystemTime(HOY);
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
    pintar([item("a", 29, { title: "pensar en ideas de contenido" })]);
    expect(screen.getByText("pensar en ideas de contenido")).toBeTruthy();
  });

  it("con su etiqueta delante, que es la hora o el folio", () => {
    vi.useFakeTimers();
    pintar([item("a", 29, { label: "#2" })]);
    expect(screen.getByText("#2")).toBeTruthy();
  });

  // Varios el mismo día se leen todos, no se resumen en un número.
  it("tres el mismo día se leen los tres", () => {
    vi.useFakeTimers();
    pintar([item("a", 12), item("b", 12), item("c", 12)]);
    expect(screen.getByText("tarea a")).toBeTruthy();
    expect(screen.getByText("tarea b")).toBeTruthy();
    expect(screen.getByText("tarea c")).toBeTruthy();
  });
});

describe("abrir uno", () => {
  it("se abre de un clic, sin pasar por el día", () => {
    vi.useFakeTimers();
    const onOpen = pintar([item("a", 29, { title: "abrir esto" })]);
    fireEvent.click(screen.getByText("abrir esto"));
    expect(onOpen).toHaveBeenCalledWith("a");
  });
});

describe("cuando no caben", () => {
  // Un día con seis cosas no puede leerse como un día con tres.
  it("dice cuántos faltan", () => {
    vi.useFakeTimers();
    pintar([item("a", 12), item("b", 12), item("c", 12), item("d", 12), item("e", 12)]);
    expect(screen.getByText("+2 more")).toBeTruthy();
  });

  it("y al pulsarlo salen todos", () => {
    vi.useFakeTimers();
    pintar([item("a", 12), item("b", 12), item("c", 12), item("d", 12)]);
    expect(screen.queryByText("tarea d")).toBeNull();
    fireEvent.click(screen.getByText("+1 more"));
    expect(screen.getByText("tarea d")).toBeTruthy();
  });

  it("con tres o menos no sobra nada que anunciar", () => {
    vi.useFakeTimers();
    pintar([item("a", 12), item("b", 12), item("c", 12)]);
    expect(screen.queryByText(/more$/)).toBeNull();
  });
});

describe("hoy", () => {
  // Antes lo más llamativo de la pantalla era el día **seleccionado**, con un
  // borde grueso; hoy sólo cambiaba de color. Lo que orienta es hoy.
  it("se marca con un círculo relleno", () => {
    vi.useFakeTimers();
    pintar([]);
    const celda = screen.getAllByText("26").find((e) => e.className.includes("rounded-full"));
    expect(celda?.className).toContain("bg-primary");
  });

  it("y los demás días no", () => {
    vi.useFakeTimers();
    pintar([]);
    const otro = screen.getAllByText("27").find((e) => e.className.includes("rounded-full"));
    expect(otro?.className ?? "").not.toContain("bg-primary");
  });
});
