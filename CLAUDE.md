# cac — lo que hay que saber antes de tocar

Monorepo: `app/` (Tauri 2 + React 19, el cliente de escritorio), `backend/` (Go +
chi + GORM + Postgres, la API en `cac.guz-studio.dev`), `swarm-manage/` (agente
por host), `widget/` (reporter embebible), `infra/`.

Los comentarios del código de este repo son buenos y explican el *por qué*. Aquí
sólo va lo que no cabe en un comentario porque no tiene un sitio único donde
vivir. Lo demás, léelo donde está.

## El método de la casa: mutar toda prueba nueva

Una prueba que no se ha mutado no se sabe si prueba algo. Escribe la prueba,
rómpele el código a propósito, y comprueba que la prueba se queja. Es lo que ha
encontrado los fallos de verdad en este repo — hay comentarios que lo dicen por
su nombre (`meeting_rule_test.go`, `report_project_patch_test.go`,
`useEncogerEnLlamada.test.tsx`, `locale-sync.test.ts`).

Hay una skill para el ritual: `/mutar`. **Un mutante vivo se investiga, no se
ignora.**

## Las trampas que ya han mordido

**Hay dos máquinas de estados, no una.** `ReportStatus.CanTransitionTo` sólo
conoce el estado, así que sólo puede contestar por la del **cliente**, que es
estricta a propósito. Lo que hay que preguntar es
`domain.CanTransition(ficha.Flow(), from, to)`. Aplicarle la estricta a una tarea
interna deja botones que no hacen nada y no dicen por qué — así se murió el check
de las subtareas. Ver `backend/internal/core/domain/report.go` (sección «Dos
máquinas, y por qué»).

**En el flujo del cliente, `pending → resolved` no existe**: hay que pasar por
`in_progress`. Mover directo devuelve 409. En el interno se puede ir de cualquier
sitio a cualquier sitio, y **cerrado no es terminal**.

**Una subtarea siempre es interna**, porque `CreateTask` le borra el `ProjectID`
al crearla (no gastar un folio del cliente en una línea de checklist). De eso
depende que el check de «hecho» funcione: salta de Open a Done, que sólo es legal
en el flujo interno.
→ Guardián: `domain.TestUnaSubtareaEsInterna` y `service/subtarea_interna_test.go`.

**`dueAt` es una fecha guardada como instante.** Léela con `diaDeVencimiento`
(`app/src/lib/mes.ts`). Con los captadores locales (`getDate()`, etc.) el día se
corre un día al oeste de Greenwich.
→ Guardián: `app/src/lib/mes.test.ts`.

**Un nombre para enseñar sale de `nombreVisible`**
(`backend/internal/core/repository/nombres.go`), nunca de `username` a mano: un
identificador de acceso no es cómo se llama a una persona. Buscar, mencionar e
identificar sí van por `username`.
→ Guardián: `repository.TestNadieResuelveElNombreASuAire` y `nombres_sql_test.go`.

**La medida de lectura de un documento (68ch) es para la prosa**, no para tablas
ni bloques de código: puesta al cuerpo entero, una tabla ancha «cabe» partiendo
las palabras a mitad y su propio deslizamiento no se activa nunca.
→ Guardián: `app/src/components/markdown/enlaces.test.tsx` («la medida de
lectura de un documento»).

**Un aviso del sistema no le pregunta al foco.** Tener la ventana con el foco no
es estar mirando eso. La puerta que había («si tiene el foco, no avises») está
quitada a propósito; no la vuelvas a poner.
→ Guardián: `app/src/hooks/avisos-del-sistema.test.tsx` («la puerta del foco»).

## El CI corre las pruebas del backend, y sólo ésas

`backend.yml` tiene por delante un trabajo `test` con Postgres de verdad, y el
despliegue depende de él: rojo no sale a producción. Es lo que pedía la tarjeta
#38, y al encenderlo salió una prueba que llevaba meses roja sin que nadie
pudiera verlo.

**El resto no tiene red.** `swarm-manage.yml` construye, `app-release.yml`
empaqueta, y ni `app/` ni `transcriber/` corren sus suites en ninguna parte.
Para esos dos, verificar en local sigue siendo lo único que hay.

Y ojo con el verde de `go test` **en local**: las pruebas que necesitan Postgres
se **saltan** sin base (`t.Skip("no database configured")` cuando no hay
`DB_HOST`), y son treinta ficheros. Sin `DB_HOST` puesto, un verde no significa
que se hayan corrido todas — en CI ya no puede pasar, en tu máquina sí.

## La puerta de verificación

Entera, antes de dar algo por hecho. Desde la raíz del repo:

```sh
(cd app           && npx tsc --noEmit)                            # tipos
(cd app           && bun run test)                                # eslint + vitest
(cd app/src-tauri && cargo check)                                 # el lado Rust
(cd backend       && go build ./... && go vet ./... && go test ./...)
```

## Soltar una release

Hay skill: `/soltar`. El orden importa y no perdona: **el backend despliega antes
que la app**. Al revés, una app nueva habla con un servidor que no la entiende y
quien actualiza rápido se come el rato. La versión es siempre la **siguiente**;
nunca se re-corta una publicada.

## Convenciones

- **El código se escribe en inglés y se comenta en castellano.** Ficheros,
  funciones, tipos, variables y campos: inglés. Comentarios y prosa: castellano.
- **No imitar los nombres en castellano que ya existen.** Hay muchos
  —`nombreVisible`, `diaDeVencimiento`, `subtarea_interna_test.go`,
  `TestElTimbreSuenaEnUnSoloEscritorio`— y son deriva, no la convención. Copiar
  lo de alrededor es exactamente cómo se sigue mezclando. En código nuevo,
  inglés sin excepciones; y lo que ya está se renombra **al pasar por el
  fichero**, no en una barrida.
- **El texto que lee una persona no es código**: va en su idioma, y vive en los
  catálogos de `app/src/locales/`, nunca en un identificador.
- Commits de una sola línea, sin trailers ni líneas de atribución, firmados.
- Se commitea directo a `main`.
- `STATUS.md` es el doc de seguimiento: actualízalo al empezar o terminar algo,
  o al cambiar de rumbo.

## Y esto no obliga a nada

Un `CLAUDE.md` es una nota, no un guardián. Lo que obliga son las pruebas — por
eso las reglas de arriba que ya tienen una la citan al lado: para que quien las
cambie sepa qué se va a romper y por qué existe. Si añades una regla aquí sin
prueba, es un recordatorio; si te importa de verdad, escríbele la prueba.
