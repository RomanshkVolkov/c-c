import type { Condition, HealthRule, TelemetryConfig } from "@/types/telemetry";

/**
 * La configuración de telemetría de un proyecto como la escribe una persona en
 * un formulario, y de vuelta. Todo texto, porque es lo que dan las cajas; el
 * paso a tipos (número, booleano) se hace aquí, en un solo sitio.
 */

export const OPS: Condition["op"][] = ["==", "!=", ">", ">=", "<", "<=", "exists", "missing"];

/** Los operadores que no llevan valor. */
export const noValue = (op: Condition["op"]) => op === "exists" || op === "missing";
/** Los que comparan números. */
export const numeric = (op: Condition["op"]) => op === ">" || op === ">=" || op === "<" || op === "<=";

export interface ConditionForm {
  path: string;
  op: Condition["op"];
  value: string;
}

export interface RuleForm extends ConditionForm {
  severity: HealthRule["severity"];
  message: string;
}

export interface ConfigForm {
  retentionDays: string;
  rules: RuleForm[];
  heartbeatOn: boolean;
  intervalSeconds: string;
  graceSeconds: string;
  activeWhen: ConditionForm;
}

/**
 * Lo que una persona quiso decir con lo que escribió en «valor»: `true` es el
 * booleano, `905` el número, y lo demás texto. Para comparar «> 600» tiene que
 * ser número; si no lo es, `undefined`, y `formErrors` lo dice.
 */
export function parseValue(op: Condition["op"], raw: string): unknown {
  if (noValue(op)) return undefined;
  const v = raw.trim();
  if (numeric(op)) return v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

function showValue(v: unknown): string {
  if (v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

const emptyCondition = (): ConditionForm => ({ path: "", op: "==", value: "" });

export const emptyRule = (): RuleForm => ({ ...emptyCondition(), severity: "warn", message: "" });

export function toForm(c: TelemetryConfig | undefined): ConfigForm {
  const hb = c?.heartbeat;
  return {
    retentionDays: c?.retentionDays ? String(c.retentionDays) : "",
    rules: (c?.healthRules ?? []).map((r) => ({
      path: r.path, op: r.op, value: showValue(r.value), severity: r.severity, message: r.message,
    })),
    heartbeatOn: !!hb,
    intervalSeconds: hb ? String(hb.intervalSeconds) : "300",
    graceSeconds: hb ? String(hb.graceSeconds) : "120",
    activeWhen: hb?.activeWhen
      ? { path: hb.activeWhen.path, op: hb.activeWhen.op, value: showValue(hb.activeWhen.value) }
      : emptyCondition(),
  };
}

function toCondition(c: ConditionForm): Condition {
  const out: Condition = { path: c.path.trim(), op: c.op };
  const v = parseValue(c.op, c.value);
  if (v !== undefined) out.value = v;
  return out;
}

export function fromForm(f: ConfigForm): TelemetryConfig {
  const out: TelemetryConfig = {};
  const days = Number(f.retentionDays);
  if (f.retentionDays.trim() && days > 0) out.retentionDays = days;
  const rules = f.rules.filter((r) => r.path.trim());
  if (rules.length) {
    out.healthRules = rules.map((r) => ({ ...toCondition(r), severity: r.severity, message: r.message.trim() }));
  }
  if (f.heartbeatOn) {
    out.heartbeat = {
      intervalSeconds: Number(f.intervalSeconds),
      graceSeconds: Number(f.graceSeconds) || 0,
    };
    if (f.activeWhen.path.trim()) out.heartbeat.activeWhen = toCondition(f.activeWhen);
  }
  return out;
}

/** Los mismos límites que el servidor, dichos antes de mandar. */
export type FormError =
  | { field: "retention" }
  | { field: "interval" }
  | { field: "grace" }
  | { field: "rule"; index: number; what: "message" | "number" }
  | { field: "activeWhen" };

export function formErrors(f: ConfigForm): FormError[] {
  const errs: FormError[] = [];
  if (f.retentionDays.trim()) {
    const d = Number(f.retentionDays);
    if (!Number.isInteger(d) || d < 1 || d > 90) errs.push({ field: "retention" });
  }
  f.rules.forEach((r, index) => {
    if (!r.path.trim()) return;
    if (!r.message.trim()) errs.push({ field: "rule", index, what: "message" });
    if (numeric(r.op) && parseValue(r.op, r.value) === undefined) errs.push({ field: "rule", index, what: "number" });
  });
  if (f.heartbeatOn) {
    const i = Number(f.intervalSeconds);
    if (!Number.isInteger(i) || i < 60 || i > 86400) errs.push({ field: "interval" });
    const g = Number(f.graceSeconds || "0");
    if (!Number.isInteger(g) || g < 0 || g > 86400) errs.push({ field: "grace" });
    if (f.activeWhen.path.trim() && numeric(f.activeWhen.op) && parseValue(f.activeWhen.op, f.activeWhen.value) === undefined) {
      errs.push({ field: "activeWhen" });
    }
  }
  return errs;
}

/** Todas las rutas hoja de un JSON, para sugerirlas al escribir una regla. */
export function leafPaths(v: unknown, prefix = "", out: string[] = []): string[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    if (prefix) out.push(prefix);
    return out;
  }
  for (const [k, child] of Object.entries(v)) leafPaths(child, prefix ? `${prefix}.${k}` : k, out);
  return out;
}
