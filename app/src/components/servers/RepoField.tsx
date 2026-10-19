import { usePresence } from "@/lib/use-presence";
import { useEffect, useMemo, useState } from "react";
import { Github } from "lucide-react";

import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { APIResponse } from "@/types/auth";
import type { GitHubStatus } from "@/types/github";

/**
 * El repo de un servicio, elegido de los que ve la GitHub App de la org en vez
 * de escrito a mano: un nombre mal escrito no casa con nada, y construir en el
 * servidor necesita un repo que la App pueda clonar.
 *
 * Se escribe para buscar y se elige de la lista. Sin la App (o sin repos), es
 * la casilla de texto de siempre: el deploy por el aviso del CI no la necesita.
 * Un nombre que la App no ve se puede guardar, pero se dice.
 */
export default function RepoField({
  orgId,
  value,
  onChange,
}: {
  orgId: string;
  value: string;
  onChange: (repo: string) => void;
}) {
  const { t } = useT();
  const [repos, setRepos] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<APIResponse<GitHubStatus>>(`/api/v1/organizations/${orgId}/github/`, true)
      .then((res) => {
        // Sin la App el backend ya contesta sin repos: queda la casilla.
        if (alive) setRepos((res?.data?.repos ?? []).map((r) => r.fullName).sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [orgId]);

  const q = value.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? repos.filter((r) => r.toLowerCase().includes(q)) : repos).slice(0, 8),
    [repos, q],
  );
  // GitHub no distingue mayúsculas: `dwit-mexico/web-boaty` es el mismo repo.
  const known = !q || repos.some((r) => r.toLowerCase() === q);

  const list = usePresence(
    open && repos.length > 0 && matches.length > 0 && !(matches.length === 1 && matches[0].toLowerCase() === q),
  );

  return (
    <div className="relative">
      <Input
        id="ci-repo"
        className="h-8 font-mono text-xs"
        placeholder={repos.length > 0 ? t("common:deploy.ci.repoSearch") : "owner/repo"}
        value={value}
        autoComplete="off"
        role={repos.length > 0 ? "combobox" : undefined}
        aria-expanded={repos.length > 0 ? open && matches.length > 0 : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Después del clic en una opción: con el blur primero, la lista se
        // cerraría antes de recibirlo.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {list.present && (
        <ul role="listbox" data-closing={list.closing || undefined} className="motion-pop-in absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {matches.map((r) => (
            <li key={r}>
              <button
                type="button"
                role="option"
                aria-selected={r === value}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(r);
                  setOpen(false);
                }}
              >
                <Github className="size-3 shrink-0 text-muted-foreground" />
                {r}
              </button>
            </li>
          ))}
        </ul>
      )}
      {repos.length > 0 && !known && <p className="mt-1 text-xs text-warning">{t("common:deploy.ci.repoUnknown")}</p>}
    </div>
  );
}
