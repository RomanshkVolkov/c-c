import { refreshAccessToken } from "@/lib/api";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";

/**
 * Adoptar un cambio de pertenencia sin volver a entrar.
 *
 * **Primero el token, y ése es todo el arreglo.** El que hay en memoria sigue
 * diciendo que no perteneces —lo firmó el servidor antes de que te añadieran—
 * así que pedir las organizaciones antes de renovarlo devuelve exactamente la
 * lista de antes y deja la pantalla igual. Que es el síntoma que se venía a
 * quitar, reproducido por hacer las cosas en el orden cómodo.
 *
 * Función con nombre y fuera del conmutador de eventos porque lo que hay que
 * poder comprobar es **el orden**, y un orden metido en un `case` sólo se puede
 * comprobar leyendo el fuente.
 */
export async function adoptarMembresia(): Promise<void> {
  await refreshAccessToken();
  // `fetchOrgs` se encarga del caso feo: si la organización que estabas mirando
  // es de la que te acaban de sacar, salta a otra en vez de dejarte en una donde
  // cada petición daría error sin explicar por qué.
  await useOrgsStore.getState().fetchOrgs();
  // El árbol es de la organización, así que también miente.
  await useTasksStore.getState().fetchTree();
}
