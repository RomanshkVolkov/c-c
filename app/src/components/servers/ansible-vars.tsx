import { useT } from "@/lib/i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AnsibleManifest, PlaybookDef } from "@/types/ansible";

/**
 * Las variables de unos playbooks del manifiesto v2, leídas para pintarlas
 * como un formulario en vez de un JSON: cada una con su descripción (la
 * primera que la tenga, en el orden de las etapas) y su default.
 *
 * - `shared`: las que traen default. Son de la plantilla: valen igual para
 *   todos los servidores que la usan.
 * - `perServer`: las que no traen default (dominio, IP, llaves). Las pone cada
 *   servidor en su config.
 * - `secrets`: los secretos por NOMBRE, con lo que son. Nunca un valor.
 */
export interface VarField {
  name: string;
  description: string;
  default?: unknown;
  required: boolean;
}
export interface SecretField {
  name: string;
  description: string;
  /** La contraseña de sudo: de cada máquina por defecto. */
  sudo: boolean;
}

export function varFields(manifest: AnsibleManifest, playbookIds: string[]) {
  const chosen = playbookIds.map((id) => manifest.playbooks.find((p) => p.id === id)).filter((p): p is PlaybookDef => !!p);
  const byName = new Map<string, VarField>();
  const secrets = new Map<string, SecretField>();
  for (const p of chosen) {
    for (const v of p.vars) {
      if (v.from) {
        const s = secrets.get(v.from);
        if (!s) secrets.set(v.from, { name: v.from, description: v.description ?? "", sudo: false });
        else if (!s.description && v.description) s.description = v.description;
        continue;
      }
      if (v.secret) continue;
      const has = v.default !== undefined && v.default !== null;
      const f = byName.get(v.name);
      if (!f) byName.set(v.name, { name: v.name, description: v.description ?? "", default: has ? v.default : undefined, required: v.required });
      else {
        if (!f.description && v.description) f.description = v.description;
        if (f.default === undefined && has) f.default = v.default;
        f.required = f.required || v.required;
      }
    }
    if (p.become && p.becomePasswordFrom) {
      const s = secrets.get(p.becomePasswordFrom);
      if (s) s.sudo = true;
      else secrets.set(p.becomePasswordFrom, { name: p.becomePasswordFrom, description: "", sudo: true });
    }
  }
  const all = [...byName.values()];
  return {
    shared: all.filter((f) => f.default !== undefined),
    perServer: all.filter((f) => f.default === undefined).sort((a, b) => Number(b.required) - Number(a.required)),
    secrets: [...secrets.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Un valor como se escribe en un campo de texto. */
export function toInput(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Lo escrito, de vuelta a su tipo. Se parece al default si lo hay (con un
 * default de texto, sigue siendo texto aunque sean cifras: «0755», porque sólo
 * se convierte lo que se parece al default o lo que no tiene); sin default, un número es
 * número, `true`/`false` booleano y `[…]`/`{…}` JSON si se lee. Vacío es
 * `undefined`: no se guarda.
 */
export function fromInput(text: string, like?: unknown): unknown {
  const s = text.trim();
  if (s === "") return undefined;
  if (typeof like === "number" || (like === undefined && /^-?\d+(\.\d+)?$/.test(s))) {
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
  }
  if (typeof like === "boolean" || like === undefined) {
    if (s === "true") return true;
    if (s === "false") return false;
  }
  if (Array.isArray(like) || (like && typeof like === "object") || (like === undefined && /^[[{]/.test(s))) {
    try {
      return JSON.parse(s);
    } catch {
      return text;
    }
  }
  return text;
}

/** Un campo del formulario de variables: nombre, para qué es y su valor. */
export function VarInput({
  field,
  value,
  placeholder,
  onChange,
  readOnly,
  idPrefix,
}: {
  field: VarField;
  value: unknown;
  placeholder?: string;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
  idPrefix: string;
}) {
  const { t } = useT();
  const id = `${idPrefix}-${field.name}`;
  const list = Array.isArray(field.default) || Array.isArray(value);
  return (
    <div className="space-y-0.5">
      <Label htmlFor={id} className="font-mono text-xs">
        {field.name}
        {field.required && value === undefined && !placeholder ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Input
        id={id}
        className="h-8 font-mono text-xs"
        value={toInput(value)}
        placeholder={placeholder ?? (list ? '["…", "…"]' : "")}
        readOnly={readOnly}
        onChange={(e) => onChange(fromInput(e.target.value, field.default))}
      />
      {(field.description || list) && (
        <p className="text-[11px] text-muted-foreground">
          {field.description}
          {list ? ` ${t("common:serverConfig.listHint")}` : ""}
        </p>
      )}
    </div>
  );
}
