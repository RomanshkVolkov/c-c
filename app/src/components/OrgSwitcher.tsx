import { useState } from "react";
import { Building2, ChevronsUpDown, Check, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import { BrandMark } from "@/components/brand/Brand";

/**
 * Con qué organización estás trabajando, y cómo cambiarla.
 *
 * La organización decide lo que enseña cada pantalla de abajo, y la única señal
 * de en cuál estabas era un selector que había que abrir. Nombrarla —con tu
 * rol, cuánta gente hay y cuántos espacios tiene— deja ver de un vistazo si vas
 * a escribir en el espacio de un cliente o en el tuyo.
 *
 * La cuenta de miembros viene servida con la organización en vez de contarse
 * aquí: hacerlo en el cliente obligaría a traerse la lista entera de cada
 * organización en pantalla sólo para poner un número al lado del nombre.
 *
 * Dos sitios lo piden —el encabezado del sidebar y el de la pantalla de
 * organización— y lo único distinto entre ellos es el disparador: uno es una
 * fila de barra lateral, el otro un botón. La lista y el diálogo de crear son
 * los mismos, así que lo que varía es una prop y no un segundo componente que
 * se quedaría atrás a la primera corrección.
 */
export default function OrgSwitcher({ variant = "sidebar" }: { variant?: "sidebar" | "button" }) {
  const orgs = useOrgsStore((s) => s.orgs);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const setCurrentOrg = useOrgsStore((s) => s.setCurrentOrg);
  const createOrg = useOrgsStore((s) => s.createOrg);
  const current = orgs.find((o) => o.id === currentOrgId) ?? null;
  const espacios = useTasksStore((s) => s.tree.length);
  // Rol, gente y espacios en una línea. Vivía en un bloque propio encima de
  // esta fila, que repetía el nombre de la organización dos veces seguidas; es
  // información de la misma cosa, así que va con ella.
  const seña = current
    ? [
        current.role,
        current.memberCount
          ? `${current.memberCount} member${current.memberCount === 1 ? "" : "s"}`
          : "",
        espacios ? `${espacios} space${espacios === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const org = await createOrg({ name: trimmed });
      toast.success(`Organization "${org.name}" created`);
      setName("");
      setDialogOpen(false);
    } catch (e) {
      toast.error("Failed to create organization", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const menu = (
        <DropdownMenu>
          {variant === "button" ? (
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <Building2 className="size-4" />
              Switch organization
              <ChevronsUpDown className="size-3.5 opacity-60" />
            </DropdownMenuTrigger>
          ) : (
            <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
              {/* El icono de la app, no un edificio genérico: es la única marca
                  que lleva el sidebar desde que esta fila absorbió la cabecera
                  que la repetía. */}
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <BrandMark className="h-4 w-auto" />
              </div>
              <div className="flex flex-1 flex-col gap-0.5 overflow-hidden text-left leading-none">
                <span className="truncate text-[12.5px] font-semibold">
                  {current?.name ?? "No organization"}
                </span>
                {seña && (
                  <span className="truncate text-[10.5px] capitalize text-muted-foreground">
                    {seña}
                  </span>
                )}
              </div>
              <ChevronsUpDown className="ml-auto size-3.5 shrink-0 opacity-60" />
            </DropdownMenuTrigger>
          )}
          <DropdownMenuContent
            align="start"
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Organizations
              </DropdownMenuLabel>
              {orgs.map((o) => (
                <DropdownMenuItem key={o.id} onClick={() => setCurrentOrg(o.id)}>
                  <Building2 className="size-4" />
                  <span className="flex-1 truncate">{o.name}</span>
                  {o.id === currentOrgId && <Check className="size-4" />}
                </DropdownMenuItem>
              ))}
              {orgs.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  No organizations yet
                </div>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" />
              Create organization
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
  );

  const dialogo = (
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
            <DialogDescription>
              Separates servers, collections and reports by company. You become
              its admin.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleCreate();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={submitting || !name.trim()}>
              {submitting ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );

  // El botón se pone donde caiga; la fila necesita ir dentro de la maquinaria
  // de la barra lateral para heredar su colapso.
  if (variant === "button") {
    return (
      <>
        {menu}
        {dialogo}
      </>
    );
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>{menu}</SidebarMenuItem>
      {dialogo}
    </SidebarMenu>
  );
}
