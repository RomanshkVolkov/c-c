import { api } from "@/lib/api";
import { useLocaleStore, type LocalePreference } from "@/store/locale.store";
import type { Session } from "@/types/auth";

/**
 * El idioma, de ida y de vuelta entre esta máquina y el servidor.
 *
 * Vive aparte del store por una razón de forma y no de gusto: `locale.store`
 * lo importa `i18n.ts`, y si el store importara a su vez el cliente HTTP
 * —que importa el store de sesión— habría un ciclo. Un ciclo deja a alguien a
 * medio evaluar según quién se importe primero, y eso cambia entre la
 * aplicación y las pruebas, que es la peor clase de diferencia. Aquí el store
 * sigue siendo una preferencia sin red y esto es la única pieza que sabe de las
 * dos cosas.
 */

/**
 * Elegir idioma: se aplica aquí y se cuenta allá.
 *
 * En ese orden y sin esperar. La interfaz cambia en el acto porque quien acaba
 * de pulsar «ES» quiere verlo ya, no cuando conteste la red; guardarlo en el
 * servidor es lo que hace que le siga a otra máquina y —lo que de verdad
 * importa— lo que permite que el servidor le **escriba los avisos** en su
 * idioma.
 *
 * Un fallo de red no se enseña. La preferencia local ya quedó guardada, así
 * que lo único que se pierde es que la otra máquina tarde en enterarse; un
 * error por eso sería ruido sobre algo que quien mira no puede arreglar.
 */
export async function chooseLocale(preference: LocalePreference): Promise<void> {
  useLocaleStore.getState().setPreference(preference);
  // «system» viaja como vacío: en el servidor no existe esa idea —no sabe qué
  // ordenador tienes— y lo que significa es «no he elegido», que es justo lo
  // que dice una columna vacía.
  const locale = preference === "system" ? "" : preference;
  // `try` y no `.catch`, y la diferencia importa: `.catch` sólo atrapa la
  // promesa rechazada, y una llamada que reviente **antes** de devolverla —el
  // cliente sin montar, que es justo lo que pasa en una prueba que sólo simula
  // media API— se escapa por el lado. Lo destapó la suite entera.
  //
  // Que la promesa no rechace nunca es parte del contrato y no un detalle:
  // quien llama es un `onClick`, que no tiene dónde atrapar nada.
  try {
    await api.patch("/api/v1/auth/locale", { locale });
  } catch {
    // El idioma ya cambió en esta máquina. Lo único que se pierde es que la
    // otra tarde en enterarse, y por eso no se enseña nada.
  }
}

/**
 * Lo que diga el servidor al entrar manda sobre lo guardado aquí.
 *
 * Porque es lo que eligió esta misma persona, quizá en otra máquina, y lo
 * guardado aquí puede ser de antes. La copia local existe para pintar rápido
 * —la interfaz se dibuja antes de que conteste la sesión— no para ser la
 * verdad.
 *
 * Se compara antes de escribir: `setPreference` reinicia el catálogo, y hacerlo
 * en cada refresco de sesión repintaría la aplicación entera sin que nada haya
 * cambiado.
 */
export function adoptServerLocale(session: Session | null | undefined) {
  if (!session) return;
  const suyo: LocalePreference = (session.locale as LocalePreference) || "system";
  if (useLocaleStore.getState().preference !== suyo) {
    useLocaleStore.getState().setPreference(suyo);
  }
}
