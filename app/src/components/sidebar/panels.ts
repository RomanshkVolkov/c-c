import type { ComponentType } from "react";

import type { ModuleKey } from "@/lib/nav";
import CommsPanel from "@/components/sidebar/panels/CommsPanel";
import DocsPanel from "@/components/sidebar/panels/DocsPanel";
import PlatformPanel from "@/components/sidebar/panels/PlatformPanel";
import WorkPanel from "@/components/sidebar/panels/WorkPanel";

/**
 * El panel de cada módulo. La otra mitad del registro de `lib/nav.ts`
 * (`MODULES`); `panels.test.tsx` exige que las dos listas tengan las mismas
 * claves, para que un módulo nuevo no se quede sin panel ni al revés.
 *
 * Un panel sólo se monta cuando su módulo manda: lo que pida al montarse
 * —páginas de un documento, la voz de los canales— se pide cuando se mira.
 */
export const PANELS: Record<ModuleKey, ComponentType> = {
  work: WorkPanel,
  docs: DocsPanel,
  comms: CommsPanel,
  platform: PlatformPanel,
};
