import { NavLink, useLocation } from "react-router-dom";
import TabIndicator from "@/components/ui/tab-indicator";
import { useSlidingIndicator } from "@/lib/use-sliding-indicator";

export interface ServerTab {
  to: string;
  label: string;
  end?: boolean;
}

/**
 * Las pestañas de un servidor, con su indicador deslizante. Las comparten el
 * de swarm y el de kubernetes (command-and-control-298).
 *
 * NavLink marca la activa con `aria-current="page"`, que es lo que busca el
 * indicador. Las cuentas de los rótulos cambian su anchura: van en la clave.
 */
export default function ServerTabs({ tabs, ariaLabel }: { tabs: ServerTab[]; ariaLabel: string }) {
  const { pathname } = useLocation();
  const tabBar = useSlidingIndicator<HTMLElement>(`${pathname}|${tabs.map((x) => x.label).join()}`);
  return (
    <nav ref={tabBar.ref} className="relative flex shrink-0 border-b px-6" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            `-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              isActive
                ? `text-foreground ${tabBar.rect ? "border-transparent" : "border-primary"}`
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
      <TabIndicator rect={tabBar.rect} first={tabBar.first} />
    </nav>
  );
}
