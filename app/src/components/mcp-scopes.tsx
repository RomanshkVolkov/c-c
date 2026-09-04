import i18next from "i18next";
import { Trans } from "react-i18next";

import type common from "@/locales/en/common.json";
import { useT, type MessageKey } from "@/lib/i18n";

/**
 * The permissions a token can carry, in one place.
 *
 * A table rather than seven hand-written checkboxes, because the same list is
 * now needed twice: once when minting a token and once when re-permissioning
 * one. Two copies would drift, and the copy that drifts is the one describing
 * what a credential may do.
 *
 * `id` has to match the backend's scope constants exactly (`domain.ValidScope`
 * drops anything it doesn't recognize, silently — a typo here would mint a
 * token whose permission does nothing).
 */
/**
 * La clave del detalle, acotada al bloque `scopes` del catálogo.
 *
 * No es `MessageKey` porque quien la consume es `<Trans>`, que tipa su
 * `i18nKey` contra **un** espacio de nombres y no contra la tupla entera. Y
 * tampoco es «todas las claves de `common`»: eso son más de setecientas, y la
 * unión resultante hace que TypeScript se rinda con «union type too complex».
 * Acotada al bloque queda una unión de catorce que sigue saliendo del catálogo,
 * así que una errata tampoco compila.
 */
type ScopeDetailKey = `scopes.${keyof (typeof common)["scopes"] & string}`;

export interface ScopeOption {
  id: string;
  labelKey: MessageKey;
  /** Sin el prefijo `common:`: la consume `<Trans>`, que lo tipa por espacio. */
  detailKey: ScopeDetailKey;
}

export const SCOPES: ScopeOption[] = [
  {
    id: "tasks:write",
    labelKey: "common:scopes.tasksWrite",
    detailKey: "scopes.tasksWriteDetail",
  },
  {
    id: "tasks:manage",
    labelKey: "common:scopes.tasksManage",
    detailKey: "scopes.tasksManageDetail",
  },
  {
    id: "notes:write",
    labelKey: "common:scopes.notesWrite",
    detailKey: "scopes.notesWriteDetail",
  },
  {
    id: "notes:manage",
    labelKey: "common:scopes.notesManage",
    detailKey: "scopes.notesManageDetail",
  },
  {
    id: "reports:write",
    labelKey: "common:scopes.reportsWrite",
    detailKey: "scopes.reportsWriteDetail",
  },
  {
    id: "reports:manage",
    labelKey: "common:scopes.reportsManage",
    detailKey: "scopes.reportsManageDetail",
  },
  {
    id: "docs:write",
    labelKey: "common:scopes.docsWrite",
    detailKey: "scopes.docsWriteDetail",
  },
  {
    id: "docs:manage",
    labelKey: "common:scopes.docsManage",
    detailKey: "scopes.docsManageDetail",
  },
  {
    id: "collections:write",
    labelKey: "common:scopes.collectionsWrite",
    detailKey: "scopes.collectionsWriteDetail",
  },
];

export function ScopeChecklist({
  selected,
  onToggle,
  compact,
}: {
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
  /** Drops the explanations — for the edit row, where they've been read once. */
  compact?: boolean;
}) {
  const { t } = useT();
  return (
    <div className={compact ? "grid grid-cols-2 gap-1" : "grid grid-cols-2 gap-2"}>
      {SCOPES.map((s) => (
        <label key={s.id} className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={selected.includes(s.id)}
            onChange={(e) => onToggle(s.id, e.target.checked)}
          />
          <span>
            <span className="text-foreground">{t(s.labelKey)}</span>
            {!compact && (
              <span className="block">
                {/* `Trans` para todas y no sólo para la que lleva marcado: una
                    de las siete resalta un «tú» y las otras seis no, y tener dos
                    caminos de pintado significa que el día que otra necesite
                    énfasis alguien lo añadirá al camino equivocado. */}
                <Trans
                  ns="common"
                  i18nKey={s.detailKey}
                  components={{ 1: <span className="text-foreground" /> }}
                />
              </span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

/** A short, readable summary of what a token may do, for the list. */
export function describeScopes(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return "read-only";
  return scopes
    .map((id) => {
      const scope = SCOPES.find((s) => s.id === id);
      return scope ? i18next.t(scope.labelKey) : id;
    })
    .join(" · ");
}
