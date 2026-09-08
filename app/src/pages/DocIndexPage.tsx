import { useNavigate } from "react-router-dom";

import DocIndex from "@/components/docs/DocIndex";
import DocTabs from "@/components/docs/DocTabs";
import { useTasksStore } from "@/store/tasks.store";

/**
 * La pantalla de toda la documentación, y el documento que se abra desde ella.
 *
 * Las dos cosas aquí porque si no, esta pantalla no lleva a ninguna parte: abrir
 * un documento sólo cambia el estado, y quien pulsara una fila de la tabla se
 * quedaba mirando la misma tabla. Un índice del que no se puede entrar no es un
 * índice.
 *
 * Ruta propia y no una pestaña dentro de tareas: la pregunta que contesta —«qué
 * hay documentado y qué está viejo»— cruza espacios enteros, y una pantalla que
 * cruza espacios no puede colgar del espacio que resulte estar abierto.
 */
export default function DocIndexPage() {
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const closeDoc = useTasksStore((s) => s.closeDoc);
  const selectList = useTasksStore((s) => s.selectList);
  const setBoardView = useTasksStore((s) => s.setBoardView);
  const navigate = useNavigate();

  return (
    <div className="flex min-h-0 flex-1">
      {activeDoc ? (
        <DocTabs
          onView={(v) => {
            // El conmutador dice «Tablero», así que tiene que llevar al tablero.
            //
            // Antes sólo cerraba el documento y te dejaba en esta tabla: pulsabas
            // «Tablero» y aparecía un índice de documentación, que no se lee como
            // un filtro sino como que la app hizo otra cosa. El tablero no está
            // en esta ruta, así que hay que ir a la suya y seleccionar la lista
            // antes — abrirla sin seleccionarla mostraría la que estuviera abierta
            // de antes, que es peor que no ir.
            if (activeDoc.kind === "list") selectList(activeDoc.id);
            setBoardView(v);
            closeDoc();
            navigate("/tasks");
          }}
        />
      ) : (
        <DocIndex />
      )}
    </div>
  );
}
