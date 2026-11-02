import { useState } from "react";
import { useT } from "@/lib/i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  /**
   * Una lista: se escribe una por línea. Lo dice `type: list` en el manifiesto
   * o un default que es lista; una obligatoria (las llaves) no trae default,
   * y sin el tipo salía como un campo de una línea.
   */
  list: boolean;
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
      const list = v.type === "list" || Array.isArray(v.default);
      const f = byName.get(v.name);
      if (!f) byName.set(v.name, { name: v.name, description: v.description ?? "", default: has ? v.default : undefined, required: v.required, list });
      else {
        if (!f.description && v.description) f.description = v.description;
        if (f.default === undefined && has) f.default = v.default;
        f.required = f.required || v.required;
        f.list = f.list || list;
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

/** Una lista como se escribe en el área de texto: una por línea. */
export function toLines(v: unknown): string {
  if (Array.isArray(v)) return v.map(toInput).join("\n");
  return toInput(v);
}

/**
 * Lo escrito una por línea, de vuelta a lista. Las líneas vacías no cuentan
 * (una llave SSH lleva espacios, así que la línea entera es un elemento).
 * Cada elemento se parece al primero del default (`[80, 443]` da números);
 * sin default, es texto. Nada escrito es `undefined`: no se guarda.
 */
export function fromLines(text: string, like?: unknown): unknown[] | undefined {
  const items = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (items.length === 0) return undefined;
  const first = Array.isArray(like) && like.length > 0 ? like[0] : "";
  return items.map((l) => fromInput(l, first));
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
  const list = field.list || Array.isArray(value);
  // Lo que se está escribiendo se guarda tal cual mientras diga lo mismo que
  // el valor: si no, un salto de línea recién puesto (todavía vacío) se
  // perdería en cada tecla. Si el valor cambia por fuera, manda el valor.
  const [text, setText] = useState(() => toLines(value));
  const shown = JSON.stringify(fromLines(text, field.default)) === JSON.stringify(value) ? text : toLines(value);
  return (
    <div className="space-y-0.5">
      <Label htmlFor={id} className="font-mono text-xs">
        {field.name}
        {field.required && value === undefined && !placeholder ? <span className="text-destructive"> *</span> : null}
      </Label>
      {list ? (
        <Textarea
          id={id}
          className="min-h-16 font-mono text-xs break-all"
          value={shown}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => {
            setText(e.target.value);
            onChange(fromLines(e.target.value, field.default));
          }}
        />
      ) : (
        <Input
          id={id}
          className="h-8 font-mono text-xs"
          value={toInput(value)}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => onChange(fromInput(e.target.value, field.default))}
        />
      )}
      {(field.description || list) && (
        <p className="text-[11px] text-muted-foreground">
          {field.description}
          {list ? ` ${t("common:serverConfig.listHint")}` : ""}
        </p>
      )}
    </div>
  );
}
