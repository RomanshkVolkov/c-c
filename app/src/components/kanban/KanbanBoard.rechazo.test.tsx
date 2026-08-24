import { describe, expect, it, vi } from "vitest";

/**
 * Soltar donde no se puede no hace nada, y no dice nada.
 *
 * El silencio es la parte deliberada: la columna se pinta en rojo mientras el
 * puntero está encima, así que un aviso al soltar sería reñir a alguien por
 * algo que se le acababa de enseñar que no podía hacer. Es la regla que ya
 * sigue el árbol de espacios al rechazar un salto entre espacios.
 *
 * Se prueba `handleDragEnd` a través del `DndContext`, capturando el manejador
 * que el tablero le pasa — arrastrar de verdad probaría a dnd-kit, que no es
 * nuestro.
 */

const { capturado } = vi.hoisted(() => ({
  capturado: { onDragEnd: null as null | ((e: unknown) => void) },
}));

vi.mock("@dnd-kit/core", async () => {
  const real = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
  return {
    ...real,
    DndContext: (props: { onDragEnd: (e: unknown) => void; children: React.ReactNode }) => {
      capturado.onDragEnd = props.onDragEnd;
      return props.children;
    },
    DragOverlay: () => null,
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  };
});
vi.mock("@dnd-kit/sortable", async () => {
  const real = await vi.importActual<typeof import("@dnd-kit/sortable")>("@dnd-kit/sortable");
  return {
    ...real,
    useSortable: () => ({
      attributes: {}, listeners: {}, setNodeRef: () => {},
      transform: null, transition: undefined, isDragging: false,
    }),
  };
});

const { render } = await import("@testing-library/react");
const { default: KanbanBoard } = await import("./KanbanBoard");

const COLUMNAS = [
  { id: "open", title: "Open" },
  { id: "in_progress", title: "In progress" },
  { id: "done", title: "Done" },
];

/** Suelta `t1`, que vive en Open, sobre la columna indicada. */
const soltarEn = (columna: string, puedeSoltar?: (i: { columnId: string }, c: string) => boolean) => {
  const onMove = vi.fn();
  render(
    <KanbanBoard
      columns={COLUMNAS}
      items={[{ id: "t1", columnId: "open" }]}
      renderItem={() => null}
      onMove={onMove}
      puedeSoltar={puedeSoltar}
    />,
  );
  capturado.onDragEnd!({ active: { id: "t1" }, over: { id: columna } });
  return onMove;
};

describe("soltar donde no se puede", () => {
  it("no mueve nada", () => {
    const onMove = soltarEn("done", (_i, c) => c !== "done");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("y donde sí se puede, mueve", () => {
    const onMove = soltarEn("in_progress", (_i, c) => c !== "done");
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "t1", toColumnId: "in_progress" }),
    );
  });

  // Un tablero sin reglas de transición sigue funcionando: la prop es opcional
  // y su ausencia no puede significar «nada vale».
  it("sin predicado, todo se permite", () => {
    const onMove = soltarEn("done");
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ toColumnId: "done" }));
  });
});
