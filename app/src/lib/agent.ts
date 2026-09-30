import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { Server } from "@/types/server";

/**
 * Calls to a server's on-host agent (`http://<host>:<agentPort>`).
 *
 * These go straight to a VPS over the network, so they MUST have a deadline: a
 * plain fetch to an unreachable host (or a half-open socket after the machine
 * slept / the NAT dropped the conntrack entry) never settles. With a polled
 * caller that means hung requests pile up until the webview's connection pool
 * is exhausted — at which point unrelated requests queue behind them and the
 * app looks frozen until it's restarted. That was the "I have to restart the
 * app" bug; the timeout is what makes it self-heal.
 */
const AGENT_TIMEOUT_MS = 10_000;

export function agentBase(host: string, agentPort: number): string {
  return `http://${host}:${agentPort}`;
}

/**
 * Los agentes con identidad que conoce esta app: origen → id del servidor.
 *
 * Desde la versión 2 el agente exige un pase firmado por el backend en todo
 * `/api/v1`. Quien llama sólo tiene la URL (`agentBase(host, port)`), así que
 * el pase se busca por el origen: así ninguna llamada existente cambia de
 * forma. Un agente de los de antes no se registra y se le sigue hablando sin
 * pase, como siempre.
 */
const agentes = new Map<string, string>();

/** El servidor declara su agente. Lo llaman quienes cargan servidores. */
export function registerAgent(s: Pick<Server, "id" | "host" | "agentPort" | "hasAgentToken">) {
  const base = agentBase(s.host, s.agentPort);
  if (s.hasAgentToken) agentes.set(base, s.id);
  else agentes.delete(base);
}

/** Los pases, por servidor. Duran minutos; se piden otro al acercarse al final. */
const pases = new Map<string, { token: string; exp: number }>();
const MARGEN_MS = 60_000;

async function paseDe(serverId: string): Promise<string | null> {
  const p = pases.get(serverId);
  if (p && p.exp - Date.now() > MARGEN_MS) return p.token;
  const res = await api.post<APIResponse<{ token: string; expiresAt: string }>>(
    `/api/v1/servers/${serverId}/agent-session`,
    {},
    true,
  );
  if (!res.success || !res.data) return null;
  pases.set(serverId, { token: res.data.token, exp: new Date(res.data.expiresAt).getTime() });
  return res.data.token;
}

function serverDe(url: string): string | undefined {
  try {
    return agentes.get(new URL(url).origin);
  } catch {
    return undefined;
  }
}

/**
 * La URL de un stream (`EventSource`) con el pase dentro. `EventSource` no
 * sabe mandar cabeceras; el agente acepta el pase por la URL **sólo en GET**.
 */
export async function agentStreamUrl(url: string): Promise<string> {
  const id = serverDe(url);
  if (!id) return url;
  const pase = await paseDe(id);
  if (!pase) return url;
  const u = new URL(url);
  u.searchParams.set("access_token", pase);
  return u.toString();
}

export async function agentFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = AGENT_TIMEOUT_MS,
): Promise<Response> {
  const id = serverDe(url);
  if (!id) return fetchConPlazo(url, init, timeoutMs);
  const conPase = async () => {
    const pase = await paseDe(id);
    const headers = new Headers(init.headers);
    if (pase) headers.set("Authorization", `Bearer ${pase}`);
    return fetchConPlazo(url, { ...init, headers }, timeoutMs);
  };
  const res = await conPase();
  // Un 401 es un pase que ya no vale —se reacuñó la identidad, o el reloj de
  // esta máquina va adelantado—: se pide otro y se reintenta una vez.
  if (res.status !== 401) return res;
  pases.delete(id);
  return conPase();
}

async function fetchConPlazo(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    // Surface a cause the UI can show instead of a bare "aborted".
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Agent did not respond within ${timeoutMs / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** agentFetch + JSON decode, for the agent's `{success, data}` envelope. */
export async function agentJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await agentFetch(url, init);
  return (await res.json()) as T;
}

/** Cuánto se espera a una prueba de vida: corta, porque se hacen varias a la vez. */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * ¿Contesta el agente de este servidor?
 *
 * Pregunta por los nodos y no por las estadísticas: las dos prueban lo mismo
 * —que hay alguien escuchando— y la lista de nodos de un swarm son cuatro
 * líneas, mientras que las estadísticas recorren todos los contenedores de la
 * máquina. Una prueba de vida no debe costarle nada al servidor que prueba.
 */
export async function agentResponde(host: string, agentPort: number): Promise<boolean> {
  try {
    const res = await agentFetch(
      `${agentBase(host, agentPort)}/api/v1/nodes`,
      {},
      PROBE_TIMEOUT_MS,
    );
    return res.ok;
  } catch {
    return false;
  }
}
