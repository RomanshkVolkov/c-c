import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * Lo que no tiene fecha no desaparece.
 *
 * Esta vista colocaba por vencimiento y **descartaba en silencio** todo lo que no
 * tuviera uno. Como casi nadie pone vencimientos, de sesenta y cinco tareas se
 * veía una, mientras la cabecera seguía diciendo sesenta y cinco. Un calendario
 * que esconde el 98% de lo que hay no está filtrando: está mintiendo.
 */

vi.mock("@dnd-kit/core", async () => {
  const real = await vi.importActual<Record<string, unknown>>("@dnd-kit/core");
  return {
    ...real,
    // El arrastre en sí no se puede ejercitar en jsdom —no hay punteros ni
    // geometría— así que lo que se comprueba aquí es lo demás: que la tira
    // exista, que liste lo que falta y que el día sea un destino.
    useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, transform: null, isDragging: false }),
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  };
});

const ItemCalendar = (await import("@/components/ItemCalendar")).default;

const conFecha = {
  id: "a", title: "tiene fecha", at: "2026-09-07T00:00:00.000Z",
  dotClass: "bg-primary", label: "#7",
};
const sin = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, title: `sin fecha ${i}`, at: "", dotClass: "bg-muted", label: `#${100 + i}`,
  }));

afterEach(cleanup);

describe("el calendario", () => {
  it("lista debajo lo que no tiene fecha, en vez de tragárselo", () => {
    render(
      <ItemCalendar items={[conFecha]} sinFecha={sin(3)} onOpen={() => {}} onSchedule={() => {}} />,
    );
    expect(screen.getByText("sin fecha 0")).toBeTruthy();
    expect(screen.getByText("sin fecha 2")).toBeTruthy();
  });

  it("y dice cuántas son", () => {
    render(
      <ItemCalendar items={[conFecha]} sinFecha={sin(64)} onOpen={() => {}} onSchedule={() => {}} />,
    );
    expect(screen.getByText(/64/)).toBeTruthy();
  });

  // El calendario del tablero coloca por fecha de creación, y ésa no se cambia
  // arrastrando: sin `onSchedule` no debe insinuar que se pueda.
  it("sin poder programar, no invita a arrastrar", () => {
    render(<ItemCalendar items={[conFecha]} sinFecha={sin(2)} onOpen={() => {}} />);
    // Por la frase concreta y no por la palabra «drag»: dnd-kit pinta un texto
    // oculto de accesibilidad que también la lleva, y buscarla ahí daba un falso
    // positivo que no tenía nada que ver con lo que se está comprobando.
    expect(screen.queryByText(/onto a day|a un día/i)).toBeNull();
    expect(screen.getByText(/^2 (with no date|sin fecha)$/i)).toBeTruthy();
  });

  // Sin nada suelto no aparece la tira: una caja vacía que dice «0 sin fecha»
  // es ruido en la pantalla de quien lo tiene todo puesto.
  it("sin nada suelto no hay tira", () => {
    render(<ItemCalendar items={[conFecha]} onOpen={() => {}} onSchedule={() => {}} />);
    expect(screen.queryByText(/^\d+ (with no date|sin fecha)/i)).toBeNull();
  });
});
