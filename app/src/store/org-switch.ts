import { useDMStore } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";
import { restoreTasksPlace } from "@/store/places";
import { useTasksStore } from "@/store/tasks.store";

/**
 * El único sitio que reacciona a un cambio de organización.
 *
 * `setCurrentOrg` sólo escribe el id, y cada pantalla se las arreglaba por su
 * cuenta —o no—. El directo lo cerraba `DMSwitcher` comparando con la org
 * anterior en un `useRef`, y eso sólo veía los cambios hechos con `/dm`
 * montado: cambiar de org desde Tareas y volver enseñaba abierto el directo de
 * la otra. El cajón de tarea se cerraba de rebote y sólo a veces, y el
 * documento abierto —persistido— no se cerraba nunca.
 *
 * Aquí se ve **todo** cambio, venga de donde venga: el selector, crear o borrar
 * una org, que `fetchOrgs` te saque de una que ya no es tuya, o un enlace a
 * algo de otra org. Lo que se cierra es lo que lleva el sello de otra org, no
 * «todo lo abierto»: así un enlace que te cambia de org para abrir una tarea no
 * se cierra a sí mismo.
 *
 * Esto es la limpieza. La garantía está además en cada pantalla, que comprueba
 * el sello antes de pintar: si algo se escapara de aquí, seguiría sin verse.
 * Lo fija `lib/un-solo-cambio-de-org.test.ts`.
 */
export function alCambiarDeOrg(_antes: string | null, ahora: string | null) {
  const dm = useDMStore.getState();
  if (dm.conversationId && dm.conversationOrgId !== ahora) dm.close();

  const t = useTasksStore.getState();
  // Un cajón sin `detail` todavía está cargando, y no se sabe de quién es: se
  // cierra también. Quien abre una tarea para luego cambiar de org espera a
  // tenerla cargada — ver `lib/ir-en-org.ts`.
  if (t.openTaskId && t.detail?.task.orgId !== ahora) t.closeTask();
  if (t.activeDoc && t.activeDoc.orgId !== ahora) t.closeDoc();
  // El tablero en pantalla es de una lista de la org de antes. `fetchTree`
  // descarta la selección si no está en el árbol nuevo; mientras llega, no se
  // pinta el tablero de la otra.
  useTasksStore.setState({ board: null });

  // Y lo que tenías abierto en la org a la que vas. Ver `store/places.store.ts`.
  restoreTasksPlace(ahora);
}

let instalado = false;

/** Se llama una vez al arrancar, desde `main.tsx`. */
export function installOrgSwitch() {
  if (instalado) return;
  instalado = true;
  useOrgsStore.subscribe((s, prev) => {
    if (s.currentOrgId !== prev.currentOrgId) alCambiarDeOrg(prev.currentOrgId, s.currentOrgId);
  });
}
