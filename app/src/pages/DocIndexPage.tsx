import DocIndex from "@/components/docs/DocIndex";
import DocTabs from "@/components/docs/DocTabs";
import { useTasksStore } from "@/store/tasks.store";

/**
 * La pantalla de toda la documentación, y el documento que se abra desde ella.
 *
 * Las dos cosas aquí porque si no, esta pantalla no lleva a ninguna parte:
 * abrir un documento sólo cambia el estado, y quien pulsara una fila de la tabla
 * se quedaba mirando la misma tabla. Un índice del que no se puede entrar no es
 * un índice.
 *
 * Ruta propia y no una pestaña dentro de tareas: la pregunta que contesta —«qué
 * hay documentado y qué está viejo»— cruza espacios enteros, y una pantalla que
 * cruza espacios no puede colgar del espacio que resulte estar abierto.
 */
export default function DocIndexPage() {
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const closeDoc = useTasksStore((s) => s.closeDoc);

  return (
    <div className="flex min-h-0 flex-1">
      {activeDoc ? (
        // Cerrar devuelve a la tabla, que es de donde se vino. El conmutador de
        // vistas no aparece aquí: no hay tablero detrás de una tabla que cruza
        // toda la organización.
        <DocTabs onView={() => closeDoc()} />
      ) : (
        <DocIndex />
      )}
    </div>
  );
}
