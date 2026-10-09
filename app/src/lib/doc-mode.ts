/**
 * ¿Se está viendo documentación? Y si es así, en qué pantalla.
 *
 * «Documentación» no es una vista guardada como Tablero o Lista: es que hay un
 * documento abierto (`activeDoc`). Por eso, al cambiar de nodo en el árbol, el
 * clic en una lista —que lleva a «Mi trabajo»— sacaba de la documentación a
 * quien la estaba leyendo, y había que volver a pulsar «Documentación» en cada
 * lista (9-oct-2026). Con esto, quien está en documentación se queda en ella:
 * el árbol abre el documento del nodo que se pulsa.
 *
 * Devuelve la ruta en la que quedarse (`/tasks` o `/docs`, las dos pantallas
 * que pintan un documento), o null si no se está viendo documentación. Un
 * documento de otra org no cuenta: está persistido y puede sobrevivir a un
 * cambio de org (ver `store/org-switch.ts`).
 */
export function docsRoute(
  activeDoc: { orgId: string } | null | undefined,
  currentOrgId: string | null | undefined,
  pathname: string,
): "/tasks" | "/docs" | null {
  if (!activeDoc || !currentOrgId || activeDoc.orgId !== currentOrgId) return null;
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return "/docs";
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return "/tasks";
  return null;
}
