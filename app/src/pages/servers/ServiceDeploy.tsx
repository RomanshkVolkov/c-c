import { Rocket } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

import DeployPanel from "@/components/servers/DeployPanel";
import ServiceSecretRefs from "@/components/servers/ServiceSecretRefs";
import Picker from "@/components/ui/picker";
import { useT } from "@/lib/i18n";
import { goInOrg } from "@/lib/ir-en-org";
import { useServerContext } from "@/pages/servers/ServerLayout";

/**
 * «Despliegue»: todo lo de cómo despliega cac un servicio, en una página y en
 * el orden en que se piensa. Arriba, desplegar un commit y lo desplegado;
 * debajo, de dónde sale la imagen, la rama y el build en el servidor, sus
 * secrets y sus migraciones.
 *
 * Antes la configuración vivía repartida entre el modal «Desplegar» —que se
 * abre para desplegar, y ahí lo nuevo pasaba desapercibido— y la pantalla de
 * Secrets del stack; para dejar un servicio listo había que ir y volver.
 *
 * El servicio va en `?service=`, como en Secrets: aguanta una recarga y se
 * puede enlazar desde su fila.
 */
export default function ServiceDeploy() {
  const { t } = useT();
  const navigate = useNavigate();
  const { server, swarm } = useServerContext();
  const [params, setParams] = useSearchParams();
  const service = swarm.services.find((s) => s.name === params.get("service")) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-4xl shrink-0 items-center gap-3 pb-3">
        <div className="flex flex-1 items-center gap-3">
          <Rocket className="size-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("common:deploy.pageTitle")}</h1>
        </div>
        <Picker
          aria-label={t("common:deploy.pagePick")}
          value={service?.name ?? ""}
          onChange={(v) => setParams(v ? { service: v } : {}, { replace: true })}
          options={[
            { value: "", label: t("common:deploy.pagePick") },
            ...swarm.services.map((svc) => ({ value: svc.name, label: svc.name })),
          ]}
        />
      </header>
      <div className="mx-auto min-h-0 w-full max-w-4xl flex-1 space-y-4 overflow-y-auto">
        {!service ? (
          <p className="text-sm text-muted-foreground">{t("common:deploy.pageLead")}</p>
        ) : (
          <>
            <h2 className="font-mono text-sm">{service.name}</h2>
            <DeployPanel
              key={service.name}
              server={server}
              service={service}
              full
              onOpenActivity={(deployableId, orgId) => goInOrg(navigate, `/activity?deployable=${deployableId}`, orgId)}
              secrets={<ServiceSecretRefs server={server} service={service} />}
            />
          </>
        )}
      </div>
    </div>
  );
}
