import ChannelsSection from "@/components/comms/ChannelsSection";
import DirectsSection from "@/components/comms/DirectsSection";
import CommsSwitch from "@/components/mobile/CommsSwitch";
import { useCommsData } from "@/hooks/use-comms-data";
import type { CommsPath } from "@/store/layout.store";

/**
 * La lista de Comunicación en el teléfono, a todo el ancho: el selector
 * «Canales | Directos» arriba y la mitad que toca debajo.
 *
 * En el escritorio esto vive en el panel del sidebar (`CommsPanel`); en el
 * teléfono no hay panel —el sidebar es un cajón cerrado—, así que la pantalla
 * enseña la lista **o** la conversación, y ésta es la lista. Las filas son las
 * mismas que las del panel, para que un canal se lea igual en los dos.
 */
export default function CommsList({ current }: { current: CommsPath }) {
  useCommsData();
  return (
    <aside className="flex min-h-0 w-full flex-col bg-muted/10">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <CommsSwitch current={current} />
      </header>
      <nav className="min-h-0 flex-1 overflow-y-auto">
        {current === "/chat" ? <ChannelsSection plain /> : <DirectsSection plain />}
      </nav>
    </aside>
  );
}
