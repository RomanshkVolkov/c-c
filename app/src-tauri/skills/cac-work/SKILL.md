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

## 1 · Antes de tocar nada: el mapa

Llama a **`get_context` sin argumentos**. Lee el `git remote` de la carpeta
donde trabajas, encuentra el espacio al que está atado ese repo de GitHub y
devuelve, en una sola llamada y sin cuerpos:

- el árbol de carpetas y listas, con su ruta. Una lista con `projectId` es de
  un cliente;
- de cada nodo con documento: los títulos de sus pestañas (overview, runbook,
  decisions, links), su tamaño, sus subpáginas y sus últimas decisiones;
- los `.md` de los repos atados al espacio;
- las tareas que ya están en curso, para no duplicar una;
- `truncated`, si algo se recortó por tamaño: entonces hay más de lo que ves.

Con eso, **lee sólo lo que toca**:
- una sección de una pestaña: `get_doc` con `kind`, `ownerId` (el id del
  nodo), `tab` y `section` (el texto del título);
- una subpágina: `get_doc_page`;
- un `.md` del repo: `get_repo_doc`.

Para lo que no esté en el mapa, usa `search` con dos o tres palabras. Cada
acierto de un doc trae `section`, la sección donde cae: lee esa y no el
documento. Si no encuentra nada, prueba otra formulación, también en el otro
idioma («desplegar» / «deploy», «soltar» / «release»): la búsqueda es por
palabras, no por significado.

Si algo de lo que lees contradice el código, gana el código, y lo apuntas
(ver el paso 5).

## 2 · Si el repo no está atado a un espacio

`get_context` lo dice (`context-repo-not-linked`). Entonces:

1. Mira si el `CLAUDE.md` del repo nombra su lista en una sección
   «Tareas en cac»:

   ```markdown
   ## Tareas en cac

   - **App** → `ca0bfd49-0909-43eb-8135-bc8ecd0f282c` (lo de `app/`)
   ```

2. Si no, llama a `list_task_spaces` y **pregúntale al usuario cuál es**,
   enseñándole las candidatas. Con su respuesta, añade esa sección al
   `CLAUDE.md` del repo.
3. Sugiérele que ate el repo al espacio en cac (en los ajustes del espacio,
   GitHub): a partir de ahí, `get_context` lo encuentra solo, para todo el
   equipo.

**No inventes una lista ni crees espacios** sin que te lo pidan. Si hay varias
listas en el espacio, elige por lo que vas a tocar, y si dudas, pregunta.

## 3 · Poner el tablero al día antes de empezar

Una tarea que se commiteó en otra sesión se queda «en curso» aunque su trabajo
ya se haya publicado: esa sesión terminó antes de que saliera, y nadie la
mueve. Así que, al llegar, revisa lo que `get_context` da en `inProgress` (o
el tablero, con `get_board`):

1. Lee el último comentario de cada una con `get_task`. Ahí debería decir qué
   falta: «sale en la próxima release», «espera a AWS», «falta probarlo en una
   llamada».
2. Si lo que faltaba ya pasó, ciérrala con `status: "done"` y un comentario que
   diga cómo lo comprobaste.
   - **Para comprobar si un commit ya se publicó:** el `git` de `get_task` trae
     sus commits.
     - **La app:** sale en una release, así que `git tag --contains <sha>` dice
       si ya está en una versión publicada.
     - **El backend o la web:** se despliegan con el push, así que un commit en
       `main` con el CI en verde ya está publicado.
   - Si no puedes comprobarlo, no la cierres: pregúntale al usuario.
3. Lo que dependa de una persona («probarlo en una llamada», «revisar en
   local»), no lo cierres por tu cuenta: díselo al usuario, en una línea por
   tarea.

Es lo primero, y es rápido: unas pocas llamadas. Si no se hace, el tablero
miente, y la siguiente sesión cree que hay trabajo pendiente donde no lo hay.

## 4 · La tarea: una, no dos

1. **Busca si ya existe**, con `search` o `get_board`. Si el usuario nombró una
   tarea (`cac#12`, un enlace), es esa.
2. **Si no existe, créala** con `create_task`:
   - con un título que diga el resultado, no la actividad («El login acepta
     correos con mayúsculas», no «Revisar login»);
   - con el porqué en la descripción, en dos o tres líneas;
   - con un `idempotencyKey`, por si reintentas.
   Si el trabajo tiene pasos, pásalos en `subtasks`: se crean en la misma
   llamada como su checklist.
3. **Muévela a «en curso»** con `update_task` y `status: "in_progress"`. No
   hace falta pedir el tablero.

**Una lista con `projectId` es de un cliente.** Lo que crees ahí lo ve ese
cliente y gasta un número de su folio para siempre. Usa
`visibility: "internal"`, salvo que el usuario diga que es para el cliente.

Por el camino:

- **Lo que descubras** va con `add_task_comment`: un fallo de base, un dato
  medido, un callejón sin salida. Los comentarios sólo se añaden; no pisan
  nada de nadie.
- **Una lista de pendientes son subtareas** (`subtasks` al crear, o
  `create_task` con `parentId` después), no texto en un comentario: así se ve
  qué está hecho. Cada una se marca con `update_task` y `status: "done"`.
- **Lo que no es tuyo** (una prueba roja que ya estaba, una deuda de otra
  parte) va como comentario en la tarea a la que le toca, o como tarea nueva
  si no la tiene.

## 5 · Lo que se decide y lo que cambia: escribirlo

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

## 6 · Al terminar: el estado honesto

Antes de decirle al usuario que terminaste, **actualiza la tarea**. Es el paso
que más se olvida, y por eso existe esta skill.

**`done` quiere decir publicado**, no commiteado: lo que el usuario ya tiene en
las manos. Una tarea empieza en `in_progress` (paso 4) y no pasa a `done` hasta
que su trabajo sale.

| Cómo quedó | `status` |
|---|---|
| Hecho, pero sin commitear o sin probar | `in_progress` |
| Commiteado y en verde, pero falta desplegar o soltar | `in_progress`, con un comentario que diga **en qué sale** («en la próxima release de la app»), para que la siguiente sesión sepa qué comprobar (paso 3) |
| Desplegado, soltado o entregado | `done` |
| Parado por una decisión del usuario o por algo de fuera | `in_progress`, con un comentario que diga qué falta |
| Descartado | `closed`, con el porqué |

Y deja un comentario de cierre corto:
- qué se hizo;
- los commits o el PR (usa `link_pull_request` si el PR no nombra la tarea);
- qué queda pendiente.

Si cambias de rumbo a mitad de camino, dilo también en la tarea: basta con una
línea.

## 7 · Lo que no se hace

- No cerrar una tarea que no está terminada para que «quede limpio».
- No crear una tarea por cada mensaje: una por trabajo, con subtareas si crece.
- No reescribir la descripción ni el documento de otra persona: comenta.
- No pegar secretos, tokens ni datos de clientes en tareas, comentarios o docs.

<!-- cac-work v3 -->
