/**
 * Los Environments de 1Password como origen de los secrets de un servicio.
 *
 * Una variable de un Environment se referencia como
 * `op-env://<Environment>/<VARIABLE>`. Dónde está montado cada Environment
 * (el `.env` que 1Password monta en la máquina) es cosa de cada máquina, así
 * que se recuerda aquí, en local, por nombre de Environment; la app lo lee de
 * ahí al probar y al rotar (ver `op_env.rs`). Un valor no pasa nunca por
 * aquí: sólo nombres y rutas.
 */

export const ENV_REF = /^op-env:\/\/([^/]+)\/([A-Za-z_][A-Za-z0-9_]{0,63})$/;

/** `op-env://RRHH prod/DATABASE_URL` → `"RRHH prod"`, o null. */
export function envOf(ref: string): string | null {
  const m = ENV_REF.exec(ref.trim());
  return m ? m[1] : null;
}

/** Los Environments que usan unas referencias, sin repetir y en orden. */
export function envsIn(refs: string[]): string[] {
  return [...new Set(refs.map(envOf).filter((e): e is string => !!e))].sort();
}

/**
 * Las filas que salen de importar un Environment: una por variable, con su
 * referencia. Las `NEXT_PUBLIC_*` se marcan como de build: Next las mete en
 * la imagen al compilar y en el servicio en marcha no sirven de nada. Las que
 * ya están (por nombre) no se tocan.
 */
export function envImportRows(env: string, names: string[], have: Set<string>) {
  return names
    .filter((n) => /^[A-Z_][A-Z0-9_]{0,39}$/.test(n) && !have.has(n))
    .map((n) => ({
      name: n,
      opRef: `op-env://${env}/${n}`,
      usage: (n.startsWith("NEXT_PUBLIC_") ? "build" : "runtime") as "build" | "runtime",
    }));
}

const KEY = "cac-op-env-mounts";

/** Dónde está montado cada Environment en esta máquina. */
export function loadMounts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveMount(env: string, path: string): Record<string, string> {
  const next = { ...loadMounts(), [env]: path };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* sin almacenamiento, vale para esta sesión */
  }
  return next;
}
