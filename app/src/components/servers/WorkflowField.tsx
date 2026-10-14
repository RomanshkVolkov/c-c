import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import Picker from "@/components/ui/picker";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { APIResponse } from "@/types/auth";

interface RepoWorkflow {
  file: string;
  name: string;
}

/**
 * El workflow que publica la imagen, elegido de los del repo (los lee la
 * GitHub App) en vez de escrito a mano. Mientras no hay repo de la org, o si
 * GitHub no contesta, es la casilla de texto de siempre.
 */
export default function WorkflowField({
  orgId,
  repo,
  value,
  onChange,
}: {
  orgId: string;
  repo: string;
  value: string;
  onChange: (file: string) => void;
}) {
  const { t } = useT();
  const [workflows, setWorkflows] = useState<RepoWorkflow[] | null>(null);

  useEffect(() => {
    setWorkflows(null);
    const r = repo.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(r)) return;
    let alive = true;
    // Un poco después de la última tecla: no una petición por letra.
    const timer = setTimeout(() => {
      api
        .get<APIResponse<RepoWorkflow[]>>(`/api/v1/organizations/${orgId}/github/workflows?repo=${encodeURIComponent(r)}`, true)
        .then((res) => alive && setWorkflows(res?.data ?? null))
        .catch(() => alive && setWorkflows(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [orgId, repo]);

  if (!workflows || workflows.length === 0) {
    return (
      <Input
        id="ci-workflow"
        className="h-8 font-mono text-xs"
        placeholder="prod.yml"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  const options = [
    { value: "", label: t("common:deploy.ci.noWorkflow") },
    ...workflows.map((w) => ({ value: w.file, label: `${w.file} · ${w.name}` })),
  ];
  // Uno guardado que ya no está en el repo se sigue viendo, para no perderlo
  // en silencio al abrir el diálogo.
  if (value && !workflows.some((w) => w.file === value)) options.push({ value, label: value });
  return (
    <Picker
      id="ci-workflow"
      aria-label={t("common:deploy.ci.workflow")}
      size="sm"
      className="h-8 w-full font-mono text-xs"
      value={value}
      onChange={onChange}
      options={options}
    />
  );
}
