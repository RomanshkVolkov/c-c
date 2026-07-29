import { useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";

/**
 * Generic kanban shared by the reports board and the tasks board.
 *
 * Replaces hand-rolled HTML5 drag & drop, which gave no drop indicator, no
 * reordering inside a column and no keyboard access. dnd-kit is pointer- and
 * keyboard-driven (space to lift, arrows to move), so the board is usable
 * without a mouse.
 *
 * Placement is reported as neighbour ids — `afterId`/`beforeId` — rather than an
 * index, because the server derives a fractional rank from them. Sending an
 * index would force it to renumber the column.
 */
export interface KanbanColumn {
  id: string;
  title: string;
  color?: string;
  /** Rendered at the column header's right edge (e.g. a count or menu). */
  accessory?: ReactNode;
  /**
   * Rendered directly under the header, above the cards — an "add" affordance
   * belongs where you start reading a column, not past the end of a long scroll.
   */
  action?: ReactNode;
}

export interface KanbanItem {
  id: string;
  columnId: string;
}

export interface KanbanMove {
  itemId: string;
  toColumnId: string;
  afterId: string;
  beforeId: string;
}

interface Props<T extends KanbanItem> {
  columns: KanbanColumn[];
  items: T[];
  renderItem: (item: T, dragging?: boolean) => ReactNode;
  onMove: (move: KanbanMove) => void;
  emptyColumnHint?: string;
  className?: string;
}

export default function KanbanBoard<T extends KanbanItem>({
  columns,
  items,
  renderItem,
  onMove,
  emptyColumnHint = "Nothing here",
  className,
}: Props<T>) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    // A small distance threshold keeps plain clicks (opening a card) from being
    // swallowed as drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byColumn = useMemo(() => {
    const map = new Map<string, T[]>();
    for (const c of columns) map.set(c.id, []);
    for (const it of items) {
      const list = map.get(it.columnId);
      if (list) list.push(it);
    }
    return map;
  }, [columns, items]);

  const active = items.find((i) => i.id === activeId) ?? null;

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;

    const itemId = String(active.id);
    const overId = String(over.id);
    const moved = items.find((i) => i.id === itemId);
    if (!moved) return;

    // Dropping onto a column's empty area targets the column itself; dropping
    // onto a card targets that card's position.
    const overItem = items.find((i) => i.id === overId);
    const toColumnId = overItem ? overItem.columnId : overId;
    if (!columns.some((c) => c.id === toColumnId)) return;

    const target = (byColumn.get(toColumnId) ?? []).filter((i) => i.id !== itemId);
    let index = target.length; // default: append
    if (overItem) {
      const overIdx = target.findIndex((i) => i.id === overId);
      if (overIdx >= 0) {
        // Moving down within the same column lands after the hovered card;
        // otherwise before it.
        const from = (byColumn.get(moved.columnId) ?? []).findIndex((i) => i.id === itemId);
        const sameColumn = moved.columnId === toColumnId;
        const movingDown = sameColumn && from < overIdx;
        index = movingDown ? overIdx + 1 : overIdx;
      }
    }

    const afterId = index > 0 ? target[index - 1]?.id ?? "" : "";
    const beforeId = index < target.length ? target[index]?.id ?? "" : "";

    // No-op drops shouldn't cost a request.
    if (moved.columnId === toColumnId && afterId === "" && beforeId === "") {
      if (target.length === 0) return;
    }
    onMove({ itemId, toColumnId, afterId, beforeId });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className={cn("flex h-full gap-3 overflow-x-auto p-4", className)}>
        {columns.map((col) => (
          <Column
            key={col.id}
            column={col}
            items={byColumn.get(col.id) ?? []}
            renderItem={renderItem}
            emptyHint={emptyColumnHint}
          />
        ))}
      </div>

      {/* The overlay follows the cursor so the card doesn't visually jump into
          its old slot while dragging. */}
      <DragOverlay dropAnimation={null}>
        {active ? <div className="w-72 rotate-2 opacity-90">{renderItem(active, true)}</div> : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column<T extends KanbanItem>({
  column,
  items,
  renderItem,
  emptyHint,
}: {
  column: KanbanColumn;
  items: T[];
  renderItem: (item: T, dragging?: boolean) => ReactNode;
  emptyHint: string;
}) {
  // Registering the column as a drop target is what makes dropping into an
  // empty column work — with only sortable items, there'd be nothing to hit.
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <section className="flex w-72 shrink-0 flex-col rounded-lg border bg-muted/20">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {column.color && (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: column.color }}
          />
        )}
        <h3 className="truncate text-xs font-semibold uppercase tracking-wide">
          {column.title}
        </h3>
        <span className="text-xs text-muted-foreground">{items.length}</span>
        <span className="ml-auto flex items-center">{column.accessory}</span>
      </header>

      {column.action && <div className="border-b px-2 py-1.5">{column.action}</div>}

      <div
        ref={setNodeRef}
        className={cn(
          "flex-1 space-y-2 overflow-y-auto p-2 transition-colors",
          isOver && "bg-primary/5",
        )}
      >
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          {items.map((item) => (
            <SortableCard key={item.id} id={item.id}>
              {renderItem(item)}
            </SortableCard>
          ))}
        </SortableContext>
        {items.length === 0 && (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">{emptyHint}</p>
        )}
      </div>
    </section>
  );
}

function SortableCard({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Without this a touch/trackpad drag scrolls the column instead of
        // lifting the card — the browser claims the gesture first.
        touchAction: "none",
      }}
      // The lifted card keeps its slot as a placeholder; the overlay shows the
      // card itself following the pointer.
      className={cn("cursor-grab active:cursor-grabbing", isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}
