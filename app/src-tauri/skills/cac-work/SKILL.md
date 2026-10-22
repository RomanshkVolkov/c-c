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

## Cuánto, según el trabajo

No todo lleva lo mismo. Una skill que pesa más que el trabajo se acaba
apagando.

| Qué te piden | Qué haces |
|---|---|
| Una pregunta, una explicación, revisar algo sin cambiarlo | Lee lo que te sirva (el mapa, una sección). **Sin tarea.** Si descubres algo que vale la pena guardar, coméntalo en la tarea a la que le toca. |
| Un arreglo pequeño, un commit | La tarea (busca si ya existe), la referencia en el commit (paso 5) y el cierre (paso 7). Sin subtareas, sin decisiones, sin tocar el runbook salvo que cambie algo de él. |
| Una feature, una investigación larga, varios commits | Todo: el mapa, el tablero al día, la tarea con sus subtareas, las decisiones y el runbook. |

Poner el tablero al día (paso 3) es para cuando vas a trabajar, no para una
pregunta, y sólo en las listas que vas a tocar.

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
(ver el paso 6).

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
     los commits que nombran la tarea (ver «Cada commit nombra su tarea»). En un
     repo no conectado, el sha está en un comentario de la tarea.
     - **La app:** sale en una release, así que `git tag --contains <sha>` dice
       si ya está en una versión publicada.
     - **El backend o la web:** se despliegan con el push, así que un commit en
       `main` con el CI en verde ya está publicado.
   - Si no puedes comprobarlo, no la cierres: pregúntale al usuario.
3. Lo que dependa de una persona («probarlo en una llamada», «revisar en
   local»), no lo cierres por tu cuenta: díselo al usuario, en una línea por
   tarea.
4. Si una tarea dice **«Espera a <ref>»** (ver el paso 4), mira con `get_task`
   o `search` si esa tarea ya está hecha. Si lo está, deja en la que esperaba
   un comentario «Desbloqueada: <ref> ya está» y díselo al usuario. Ésa puede
   seguir.

Es lo primero, y es rápido: unas pocas llamadas. Si no se hace, el tablero
miente, y la siguiente sesión cree que hay trabajo pendiente donde no lo hay.

## 4 · La tarea: una, no dos

1. **Busca si ya existe**, con `search` o `get_board`. Si el usuario nombró una
   tarea (`proteus-12`, un enlace), es esa.
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

- **Si tu tarea no puede seguir hasta que se haga otra,** déjalo escrito con un
  comentario que empiece así, con su referencia:

  ```
  Espera a command-and-control-185: necesita que el tag de la imagen lleve el servicio.
  ```

  Una línea por cada tarea de la que dependa. Así la siguiente sesión sabe qué
  está parado por qué, y lo comprueba al poner el tablero al día (paso 3). Si
  es una espera de algo de fuera (AWS, una llamada, una release), no lleva
  referencia: basta con decir qué falta.
- **Lo que descubras** va con `add_task_comment`: un fallo de base, un dato
  medido, un callejón sin salida. Los comentarios sólo se añaden; no pisan
  nada de nadie.
- **Una lista de pendientes son subtareas** (`subtasks` al crear, o
  `create_task` con `parentId` después), no texto en un comentario: así se ve
  qué está hecho. Cada una se marca con `update_task` y `status: "done"`.
- **Lo que no es tuyo** (una prueba roja que ya estaba, una deuda de otra
  parte) va como comentario en la tarea a la que le toca, o como tarea nueva
  si no la tiene.

## 5 · Cada commit nombra su tarea

Así cac enlaza solo el commit con su tarea. `create_task` y `get_task` dan su
`ref`: la clave de su espacio y su número (`proteus-12`), o el folio (`acme-7`)
si es de un cliente. Ponla al final del mensaje, entre paréntesis:

```
fix(login): acepta correos con mayúsculas (proteus-12)
```

En una rama, lo mismo con guiones: `proteus-12-login`.

- **Siempre en minúsculas.** `PROTEUS-12` es la clave de Jira, que numera por
  su lado, y cac no la toma.
- **Qué se gana:** cac enlaza solo el commit o la PR en el panel «Desarrollo»
  de la tarea, desde cualquier repo de la organización conectado a cac. Es lo
  que usa el paso 3 para saber si el trabajo ya se publicó.
- **Si el PR no nombra la tarea,** enlázalo a mano con `link_pull_request`.
- **En un repo que no está conectado a cac** (el de un cliente en su propia
  organización de GitHub: `get_context` no lo encuentra), el commit no lleva
  referencia: cac no lo vería, y el historial es del cliente. En su lugar,
  apunta en la tarea el repo y el sha: «`TCO-Org/nereus` `a1b2c3d`: …».
- `cac#12`, la forma de antes, se sigue entendiendo, pero ya no se escribe.

## 6 · Lo que se decide y lo que cambia: escribirlo

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

## 7 · Al terminar: el estado honesto

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
| Parado porque espera a otra tarea | `in_progress`, con «Espera a <ref>: …» |
| Descartado | `closed`, con el porqué |

Y deja un comentario de cierre corto:
- qué se hizo;
- los commits o el PR (usa `link_pull_request` si el PR no nombra la tarea);
- qué queda pendiente.

Si cambias de rumbo a mitad de camino, dilo también en la tarea: basta con una
línea.

## 8 · Lo que no se hace

- No cerrar una tarea que no está terminada para que «quede limpio».
- No crear una tarea por cada mensaje: una por trabajo, con subtareas si crece.
- No reescribir la descripción ni el documento de otra persona: comenta.
- No pegar secretos, tokens ni datos de clientes en tareas, comentarios o docs.

---

_Escrita por Claude (Anthropic) con jose (guz-studio), del 20 al 22 de octubre
de 2026, a partir de lo que fue fallando al trabajar con cac. Cada regla tiene
detrás algo que pasó de verdad; si cambias una, mira antes en el registro de
decisiones del espacio Command and control por qué está._

<!-- cac-work v7 -->
