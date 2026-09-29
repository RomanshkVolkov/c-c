import i18next from "i18next";
import { toast } from "sonner";
import { useOrgsStore } from "@/store/orgs.store";

/**
 * Ir a algo **en su organización**.
 *
 * Los enlaces de la app sólo llevan ids —`/dm?c=`, `/tasks?task=`,
 * `/chat?space=`—, y la pantalla que los recibe lo abre en la org que esté en
 * pantalla. Un enlace a algo de otra org (un resultado de búsqueda, un aviso,
 * volver a una llamada) acababa pintando el objeto de A dentro de B.
 *
 * Aquí se cambia de org **antes** de navegar, y el orden importa: cambiarla
 * dispara `store/org-switch.ts`, que cierra lo que es de la org de antes; si se
 * navegara primero, lo recién abierto sería lo que se cerrase. `setCurrentOrg`
 * es síncrono, así que al navegar ya está todo en su sitio.
 *
 * Una org que no es tuya no se toca: se avisa y no se navega. Devuelve si fue.
 */
export function goInOrg(navigate: (to: string) => void, link: string, orgId?: string | null): boolean {
  if (!enterOrg(orgId)) return false;
  navigate(link);
  return true;
}

/**
 * Ponerse en la org de algo, sin navegar. Para los enlaces que sólo saben su
 * org después de cargar lo que abren —`?task=`, `?doc=`, `?c=`—: se carga, se
 * mira de quién es, y se cambia. Lo recién abierto lleva ya su sello, así que
 * `org-switch` no lo cierra. Devuelve si se está en esa org.
 */
export function enterOrg(orgId?: string | null): boolean {
  const orgs = useOrgsStore.getState();
  if (!orgId || orgId === orgs.currentOrgId) return true;
  if (!orgs.orgs.some((o) => o.id === orgId)) {
    toast.error(i18next.t("common:misc.notYourOrg"));
    return false;
  }
  orgs.setCurrentOrg(orgId);
  return true;
}
