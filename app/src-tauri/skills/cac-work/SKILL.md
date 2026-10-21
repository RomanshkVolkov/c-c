---
name: cac-work
description: Trabaja con cac como la memoria del equipo. Úsala al empezar cualquier trabajo en un repo (un arreglo, una feature, una investigación) para leer su contexto en cac (overview, runbook, decisiones) y encontrar o crear su tarea, y al terminar o cambiar de rumbo para actualizar la tarea y dejar escrito lo que se decidió. También cuando pregunten en qué va algo o por qué se hizo así, o cuando digan «regístralo», «apúntalo» o «actualiza cac».
---

# Trabajar con cac

cac es la memoria del equipo. Lo que una sesión aprende se pierde al cerrarla;
lo que queda en cac lo lee la siguiente, la tuya o la de cualquier otra persona
del equipo. Por eso, en cada trabajo, **primero se lee y al final se escribe**,
sin que nadie te lo tenga que recordar.

Todo va por el MCP de cac (`mcp__cac__*`). Si no está conectado, dilo una vez
y sigue con el trabajo: no es motivo para parar.

## 1 · Dónde vive este repo en cac

Cada repo lo dice en su `CLAUDE.md`, en una sección así:

```markdown
## Tareas en cac

- **App** → `ca0bfd49-0909-43eb-8135-bc8ecd0f282c` (lo de `app/`)
- **Backend** → `91abe433-4d90-4519-93ff-616109ce40c9` (lo de `backend/`)
```

- **Si está:** usa esa lista. Si hay varias, elige por lo que vas a tocar.
- **Si no está:**
  1. Llama a `list_task_spaces` y busca el espacio y la lista que se parezcan
     al repo.
  2. **Pregúntale al usuario cuál es**, enseñándole las candidatas.
  3. Con su respuesta, añade la sección al `CLAUDE.md` del repo y díselo, para
     que la siguiente sesión no tenga que preguntar.
- **No inventes una lista ni crees espacios** sin que te lo pidan.

`list_task_spaces` también da el espacio y la carpeta de los que cuelga la
lista. Ahí está la documentación.

## 2 · Antes de tocar nada: leer

Lee lo que el equipo ya sabe, **por trozos**:

- **El documento.** `get_doc` sin `tab` devuelve el índice: los títulos de sus
  cuatro pestañas (overview, runbook, decisions, links) y los títulos del
  registro de decisiones. Después lee sólo las secciones que tienen que ver
  (`tab` + `section`). Empieza por el de la lista; si está vacío, sube a su
  carpeta y a su espacio.
- **Lo que hay sobre el tema.** `search` con dos o tres palabras de lo que vas
  a hacer encuentra tareas, notas y docs. Una tarea cerrada con el mismo
  problema suele ser la mitad del trabajo.
- **La documentación del propio repo.** `list_repo_docs` lista los README y los
  `docs/` que cac sincroniza desde GitHub, para cuando no los tengas en local.

Si algo de lo que lees contradice el código, gana el código, y lo apuntas
(ver el paso 4).

## 3 · La tarea: una, no dos

1. **Busca si ya existe**, con `search` o `get_board`. Si el usuario nombró una
   tarea (`cac#12`, un enlace), es esa.
2. **Si no existe, créala** con `create_task`:
   - con un título que diga el resultado, no la actividad («El login acepta
     correos con mayúsculas», no «Revisar login»);
   - con el porqué en la descripción, en dos o tres líneas;
   - con un `idempotencyKey`, por si reintentas.
3. **Muévela a la columna de «en curso».** `get_board` da el `statusId` de cada
   columna, y `update_task` la mueve.

**Una lista con `projectId` es de un cliente.** Lo que crees ahí lo ve ese
cliente y gasta un número de su folio para siempre. Usa
`visibility: "internal"`, salvo que el usuario diga que es para el cliente.

Por el camino:

- **Lo que descubras** va con `add_task_comment`: un fallo de base, un dato
  medido, un callejón sin salida. Los comentarios sólo se añaden; no pisan
  nada de nadie.
- **Una lista de pendientes son subtareas** (`create_task` con `parentId`), no
  texto en un comentario: así se ve qué está hecho.
- **Lo que no es tuyo** (una prueba roja que ya estaba, una deuda de otra
  parte) va como comentario en la tarea a la que le toca, o como tarea nueva
  si no la tiene.

## 4 · Lo que se decide y lo que cambia: escribirlo

- **Una decisión** (elegir una librería o un proveedor, un cambio de diseño,
  algo que se descarta y por qué) va con `record_decision`, con
  `originTaskId` de la tarea:
  - `decidedBy` es quien la tomó; si fue el usuario, su nombre;
  - el registro no se puede editar, así que escríbelo como debe leerse dentro
    de un año, con el porqué.
- **Si cambió algo del runbook** (cómo se despliega, una variable nueva, un
  comando, una trampa que mordió), actualiza esa sección con
  `write_doc_section`, pasando el `sectionHash` que leíste. Para algo nuevo, usa
  `append_doc_tab`. Si el token no tiene permiso, dile al usuario qué cambiar.
- **El overview** sólo se toca si cambió de qué va el proyecto. No lo
  reescribas por estilo.

## 5 · Al terminar: el estado honesto

Antes de decirle al usuario que terminaste, **actualiza la tarea**. Es el paso
que más se olvida, y por eso existe esta skill.

| Cómo quedó | Columna |
|---|---|
| Hecho, pero sin commitear o sin probar | en curso |
| Commiteado y en verde, pero falta desplegar o soltar | en revisión, si existe; si no, en curso |
| Desplegado, soltado o entregado | hecho |
| Parado por una decisión del usuario o por algo de fuera | bloqueada, si existe; si no, en curso con un comentario que diga qué falta |

Y deja un comentario de cierre corto:
- qué se hizo;
- los commits o el PR (usa `link_pull_request` si el PR no nombra la tarea);
- qué queda pendiente.

Si cambias de rumbo a mitad de camino, dilo también en la tarea: basta con una
línea.

## 6 · Lo que no se hace

- No cerrar una tarea que no está terminada para que «quede limpio».
- No crear una tarea por cada mensaje: una por trabajo, con subtareas si crece.
- No reescribir la descripción ni el documento de otra persona: comenta.
- No pegar secretos, tokens ni datos de clientes en tareas, comentarios o docs.

<!-- cac-work v1 -->
