import DocIndex from "@/components/docs/DocIndex";

/**
 * La pantalla de toda la documentación.
 *
 * Ruta propia y no una pestaña dentro de tareas: la pregunta que contesta —«qué
 * hay documentado y qué está viejo»— cruza espacios enteros, y una pantalla que
 * cruza espacios no puede colgar del espacio que resulte estar abierto.
 */
export default function DocIndexPage() {
  return (
    <div className="flex min-h-0 flex-1">
      <DocIndex />
    </div>
  );
}
