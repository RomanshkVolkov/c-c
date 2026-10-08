/**
 * Lee el metadata de la sala y dice si hay grabación.
 *
 * **Es el port de `recording_from_metadata` de `voice.rs`**, y tiene que decir
 * lo mismo: el motor del navegador (W3) lo usa para encender el chip REC igual
 * que el de Rust. Si los dos lo leyeran distinto, un invitado vería REC donde
 * un miembro no, o al revés — y el aviso de grabación es justo lo que no puede
 * depender de con qué motor entraste.
 *
 * Vacío, no-JSON y `"recording": null` significan lo mismo y ninguno es un
 * error. **Se exigen `id` y `by`**: un aviso sin dueño es exactamente el que da
 * miedo, y preferimos no avisar a avisar de una grabación que no se sabe de
 * quién es.
 */
export interface RecordingSignal {
  id: string;
  by: string;
  since: string;
}

export function recordingFromMetadata(raw: string | undefined | null): RecordingSignal | null {
  if (!raw) return null;
  let valor: unknown;
  try {
    valor = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!valor || typeof valor !== "object") return null;
  const rec = (valor as { recording?: unknown }).recording;
  if (!rec || typeof rec !== "object") return null;
  const { id, by, since } = rec as { id?: unknown; by?: unknown; since?: unknown };
  if (typeof id !== "string" || typeof by !== "string" || !id || !by) return null;
  return { id, by, since: typeof since === "string" ? since : "" };
}
