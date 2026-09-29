import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Un campo de contraseña con su botón de mostrarla.
 *
 * Es el único sitio de la app donde puede aparecer `type="password"`: lo fija
 * `password-input.test.tsx`, que falla si aparece uno a pelo en otro fichero.
 * Sin el ojo no hay forma de saber si lo que se tecleó es lo que se quería, y
 * en una contraseña que se le va a pasar a otra persona eso es todo.
 *
 * El botón es `type="button"` para que pulsarlo dentro de un formulario no lo
 * envíe, y el `ref` llega al `<input>` —el login lo registra con
 * react-hook-form—.
 */
function PasswordInput({
  className,
  containerClassName,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  // Para lo que tiene que ir en la caja y no en el `<input>`: un `flex-1`, un
  // margen. Puesto en el `<input>`, el ojo se descuadra.
  containerClassName?: string;
}) {
  const { t } = useT();
  const [visible, setVisible] = React.useState(false);
  const label = visible ? t("common:misc.hidePassword") : t("common:misc.showPassword");
  return (
    <div className={cn("relative", containerClassName)}>
      <Input {...props} type={visible ? "text" : "password"} className={cn("pr-8", className)} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={label}
        aria-pressed={visible}
        title={label}
        disabled={props.disabled}
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export { PasswordInput };
