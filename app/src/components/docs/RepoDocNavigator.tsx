import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useRepoDocs } from "@/store/repo-docs.store";
import { useRouteRequest } from "@/store/route-request.store";

/**
 * Hace la navegación que piden los que no tienen router a mano: un enlace a
 * un .md del repo en el chat o en un documento (`openInternalRef`), o el
 * botón de un include. Ellos apuntan la ruta en `useRepoDocs.pendingRoute`;
 * esto, montado dentro del router, la sigue. Y lo mismo con cualquier otra
 * ruta pedida por `useRouteRequest` (un enlace a un documento desde el chat).
 */
export default function RepoDocNavigator() {
  const navigate = useNavigate();
  const pending = useRepoDocs((s) => s.pendingRoute);
  const takeRoute = useRepoDocs((s) => s.takeRoute);
  useEffect(() => {
    if (!pending) return;
    const route = takeRoute();
    if (route) navigate(route);
  }, [pending, takeRoute, navigate]);
  const requested = useRouteRequest((s) => s.pending);
  const take = useRouteRequest((s) => s.take);
  useEffect(() => {
    if (!requested) return;
    const route = take();
    if (route) navigate(route);
  }, [requested, take, navigate]);
  return null;
}
