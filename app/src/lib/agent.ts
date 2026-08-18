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

export async function agentFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = AGENT_TIMEOUT_MS,
): Promise<Response> {
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
