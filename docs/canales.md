# Canales: dónde aterriza lo que manda un cliente

Un **canal** (`report_projects`) es la credencial con la que entra el trabajo de
un cliente. Este documento es dónde vive su vínculo con el tablero, quién lo
escribe y qué lo puede romper.

Se escribió después de perder `portento-99`: entró por la integración
server-to-server, no apareció en ninguna columna, y su detalle contestaba
«list not found». Estuvo así hasta que una notificación apuntó a él.

Última revisión: **2026-08-19**.

## 1 · Dos columnas, dos preguntas

| Columna | Qué contesta |
|---|---|
| `task_lists.project_id` | de quién es esta lista |
| `report_projects.list_id` | **dónde aterriza** lo que llega de ese cliente |

Parecen la misma cosa al revés y no lo son. La primera es una etiqueta en el
árbol: esta lista es de portento. La segunda es la **bandeja de entrada**, y es
la que consulta el ingest. Confundirlas funciona casi siempre y falla justo
cuando difieren.

## 2 · Quién las escribe

**Un solo sitio**: `PATCH /api/v1/task-lists/{id}/channel` →
`TaskService.BindList` (`service/task.go:243`), que escribe las dos a la vez.
Decir «esta lista es de portento» y que los reportes de portento lleguen a otra
sería un ajuste que miente.

Lo demás **no** las toca:

- `BindSpace` vincula un espacio entero y **no mueve la bandeja**, a propósito:
  un ajuste a dos niveles de distancia no debería redirigir en silencio lo que
  entra de un cliente.
- El ingest sólo las **lee**.
- La migración a items (2026-08-12) las rellenó una vez para lo que ya existía.

## 3 · Las cuatro puertas

| Intento | Qué pasa |
|---|---|
| Vincular a un canal de otra organización | `ErrChannelOtherOrg` → 403 |
| Borrar la lista que es bandeja de un canal | `ErrListInUseByChannel` → 409 |
| Borrar una lista con tickets de cliente dentro | `ErrListHoldsChannelWork` → 409 |
| **Dejar un canal sin bandeja** | `ErrChannelNeedsInbox` → 409 |

La invariante no es «esto no se mueve» sino **«un canal tiene siempre exactamente
una bandeja, y es una lista de verdad»**.

Repuntar la bandeja a otra lista es legítimo —se reorganiza un tablero, se separa
un cliente en otro espacio— y la última elección explícita gana. Congelarlo
dejaría un canal mal puesto mal para siempre, o obligaría a rotar la llave con el
cliente en producción. Lo que no puede pasar es quedarse en nada, y hasta el
19/08 se podía: desvincular limpiaba `task_lists.project_id` y **salía antes** de
tocar la bandeja, así que el canal seguía entregando en una lista que ya no se
declaraba suya y el árbol no lo decía.

## 4 · Qué hereda un reporte al entrar

Cuando el ingest valida la llave ya tiene el `ReportProject` entero en la mano, y
de ahí saca los dos campos que la fila necesita (`service/report.go`):

```
report.OrgID  = project.OrgID
report.ListID = project.ListID   // vacío si el canal no tiene bandeja
```

**Nada de esto se le pide al tenant.** La integración server-to-server no lleva
`orgId` ni `listId` y no debe llevarlos: la llave ya identifica el proyecto, y el
enrutado es una decisión nuestra que puede cambiar sin renegociar el contrato.

Que estos dos no se copiaran es el fallo que dejó a `portento-99` fuera del
tablero. La migración se los puso a los que ya existían y desde entonces cada
reporte nuevo entraba huérfano — el primero que llegó después fue el que se cayó.

## 5 · Un item sin lista

Es un estado legal, no una corrupción: un canal puede existir antes de tener
tablero. Qué significa:

- **No sale en ningún tablero.** No tiene columna en la que estar.
- **Se abre y se lee.** `TaskService.Detail` lo devuelve con `listName` y
  `spaceName` vacíos en vez de fallar. Antes contestaba «list not found» y el
  handler lo convertía en un 500: no sólo no salía, tampoco se podía mirar.
- **El ingest no lo rechaza.** Es la misma regla que el resto del ingest —una
  categoría rara se normaliza, no se rechaza—: perder el reporte de un cliente
  por un hueco de configuración nuestro es el peor de los dos fallos.

Al arrancar, `backfillIngestedItems` (`repository/db.go`) les da hogar a los que
entraron sin él, leyendo del proyecto. Sólo escribe donde está vacío, así que
nunca reasigna nada colocado y correrlo dos veces no cambia nada la segunda.

## 6 · Cómo se nota que se rompió otra vez

Un canal cuyos reportes no aparecen en su tablero. La comprobación más rápida:

```
list_reports          → cuántos hay
get_board <listId>    → cuántos se ven
```

Si el segundo número es menor, hay items sin lista. El arranque lo dice en el
log (`ingested-item backfill: …`), y un detalle que no abre ahora levanta su
propia tarjeta en el tablero de cac en vez de morir en un mensaje.

## Ver también

- [`notifications.md`](./notifications.md) — qué avisa y a quién. Aquel mapea el
  aviso; éste, de dónde sale y dónde aterriza lo que se avisa.
