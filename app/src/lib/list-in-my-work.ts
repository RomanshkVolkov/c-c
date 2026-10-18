import { useMyWorkStore } from "@/store/mywork.store";
import { useTasksStore } from "@/store/tasks.store";
import type { TaskView } from "@/types/task";

/**
 * Enseña una lista en «Mi trabajo», acotado a ella y en la vista que se pidió.
 *
 * Es a donde lleva pulsar Tablero, Lista o Calendario desde la documentación
 * de una lista, igual que pulsar la lista en el árbol (jose, 18-oct-2026): la
 * pantalla de sus tareas es ésa, no el tablero suelto. Quien llama navega a
 * `/my-work`; aquí sólo se deja el estado.
 *
 * `focusList` y no `selectList`: el tablero no se va a ver, y pedirlo sería
 * una petición que no lee nadie. Y las tareas no se piden: si ya están, «Mi
 * trabajo» no vuelve a cargar (`ensureLoaded`).
 */
export function showListInMyWork(list: { id: string; name: string }, view: TaskView) {
  const tasks = useTasksStore.getState();
  tasks.closeDoc();
  tasks.focusList(list.id);
  const work = useMyWorkStore.getState();
  work.setScope({ kind: "list", id: list.id, name: list.name });
  work.setVista(view);
}
