import { useState } from "react";
import { useT } from "@/lib/i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
   * Una lista: un campo por elemento. Lo dice `type: list` en el manifiesto
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

/** Una lista como se enseña en una sola línea (el valor heredado, en gris). */
export function listPreview(v: unknown): string {
  return Array.isArray(v) ? v.map(toInput).join(", ") : toInput(v);
}

/** Un valor como filas del formulario: una por elemento, y al menos una. */
export function toItems(v: unknown): string[] {
  if (Array.isArray(v)) return v.length > 0 ? v.map(toInput) : [""];
  return [toInput(v)];
}

/**
 * Las filas de una lista, de vuelta a lista. Las vacías no cuentan (una fila
 * recién agregada todavía no es nada); una llave SSH lleva espacios, así que
 * la fila entera es un elemento. Cada elemento se parece al primero del
 * default (`[80, 443]` da números); sin default, es texto. Nada escrito es
 * `undefined`: no se guarda.
 */
export function fromItems(rows: string[], like?: unknown): unknown[] | undefined {
  const items = rows.map((l) => l.trim()).filter((l) => l !== "");
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
  const id = `${idPrefix}-${field.name}`;
  const list = field.list || Array.isArray(value);
  return (
    <div className="space-y-0.5">
      <Label htmlFor={id} className="font-mono text-xs">
        {field.name}
        {field.required && value === undefined && !placeholder ? <span className="text-destructive"> *</span> : null}
      </Label>
      {list ? (
        <ListInput id={id} field={field} value={value} placeholder={placeholder} onChange={onChange} readOnly={readOnly} />
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
      {field.description && <p className="text-[11px] text-muted-foreground">{field.description}</p>}
    </div>
  );
}

/**
 * Una lista como filas: un campo por elemento, una × para quitarlo y «Agregar
 * otra» (o Enter en la última) para la siguiente.
 */
function ListInput({
  id,
  field,
  value,
  placeholder,
  onChange,
  readOnly,
}: {
  id: string;
  field: VarField;
  value: unknown;
  placeholder?: string;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
}) {
  const { t } = useT();
  // Las filas se guardan tal cual mientras digan lo mismo que el valor: si
  // no, una fila recién agregada (vacía todavía) desaparecería al momento.
  // Si el valor cambia por fuera, mandan las filas del valor.
  const [rows, setRows] = useState<string[]>(() => toItems(value));
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const shown = JSON.stringify(fromItems(rows, field.default)) === JSON.stringify(value) ? rows : toItems(value);
  const write = (next: string[]) => {
    setRows(next);
    onChange(fromItems(next, field.default));
  };
  const add = () => {
    setFocusRow(shown.length);
    write([...shown, ""]);
  };
  return (
    <div className="space-y-1">
      {shown.map((row, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            id={i === 0 ? id : undefined}
            aria-label={i === 0 ? undefined : `${field.name} ${i + 1}`}
            className="h-8 font-mono text-xs"
            value={row}
            placeholder={i === 0 ? placeholder : undefined}
            readOnly={readOnly}
            autoFocus={focusRow === i}
            onChange={(e) => write(shown.map((r, j) => (j === i ? e.target.value : r)))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !readOnly && i === shown.length - 1 && row.trim() !== "") {
                e.preventDefault();
                add();
              }
            }}
          />
          {!readOnly && shown.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t("common:serverConfig.removeItem", { name: field.name, n: i + 1 })}
              onClick={() => {
                setFocusRow(null);
                write(shown.filter((_, j) => j !== i));
              }}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5 text-xs" onClick={add}>
          <Plus className="size-3.5" />
          {t("common:serverConfig.addItem")}
        </Button>
      )}
    </div>
  );
}
