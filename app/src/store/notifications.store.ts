import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * What arrived, and whether the system was told about it.
 *
 * This exists because "no notification appeared" was impossible to diagnose: a
 * toast is gone in seconds and an OS notification that never fires leaves no
 * trace anywhere, so the event, the decision not to notify, and the failure all
 * looked identical — nothing.
 *
 * Every event is recorded here whatever happens to the OS notification, along
 * with why it was or wasn't sent. The inbox is the answer to "did it arrive?".
 */

export type Delivery =
  /** Handed to the OS and it took it. */
  | "os"
  /** Deliberately not sent: the window was focused, so you already saw it. */
  | "focused"
  /** Tried and the platform refused. `error` says what it said. */
  | "failed";

export interface AppNotification {
  id: string;
  /** The stream event that caused it — `report:new`, `task:comment`… */
  kind: string;
  title: string;
  body: string;
  at: number;
  delivery: Delivery;
  error?: string;
  /** Opens the report when the row is clicked, when there is one. */
  reportId?: string;
  read: boolean;
}

/** Bounded: this is a log to glance at, not history to keep. */
const MAX = 100;

interface NotificationsState {
  items: AppNotification[];
  add: (n: Omit<AppNotification, "id" | "at" | "read">) => void;
  markAllRead: () => void;
  clear: () => void;
  unread: () => number;
}

let seq = 0;

export const useNotificationsStore = create<NotificationsState>()(
  persist(
    (set, get) => ({
      items: [],

      add: (n) =>
        set((s) => ({
          // Counter, not a timestamp: two events in the same millisecond are
          // ordinary here — a status change and its comment arrive together.
          items: [{ ...n, id: `${Date.now()}-${seq++}`, at: Date.now(), read: false }, ...s.items]
            .slice(0, MAX),
        })),

      markAllRead: () => set((s) => ({ items: s.items.map((i) => ({ ...i, read: true })) })),
      clear: () => set({ items: [] }),
      unread: () => get().items.filter((i) => !i.read).length,
    }),
    {
      name: "cac-notifications",
      // Only the list: the actions rebuild themselves, and persisting them
      // would freeze today's implementation into storage.
      partialize: (s) => ({ items: s.items }),
    },
  ),
);
