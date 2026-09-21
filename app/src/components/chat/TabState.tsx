import { Loader2 } from "lucide-react";

import { useT } from "@/lib/i18n";

/**
 * Lo que una pestaña enseña cuando no tiene filas: loading, roto, o vacío.
 *
 * Los tres en un sitio porque el orden entre ellos es la regla, y repetirlo en
 * cada pestaña es cómo se acaban discrepando: **primero el fallo**. Una pestaña
 * que no pudo leer y dice «todavía no hay nada» miente, y encima invita a no
 * volver a mirar.
 */
export function TabState({
  loading,
  error,
  empty,
}: {
  loading: boolean;
  error: boolean;
  empty: string;
}) {
  const { t } = useT();
  if (error) {
    return <p className="p-6 text-center text-sm text-destructive">{t("chat:errTab")}</p>;
  }
  if (loading) {
    return (
      <div className="flex justify-center p-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <p className="p-6 text-center text-sm text-muted-foreground">{empty}</p>;
}
