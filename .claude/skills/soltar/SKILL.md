---
name: soltar
description: Corta una release de cac en el orden que no rompe a quien actualiza rápido. Úsala cuando haya que publicar, soltar, o cortar una versión de la app o desplegar el backend. El backend va antes que la app, y la versión es siempre la siguiente.
---

# Soltar

Cinco pasos, en este orden. **El orden es la parte seria**: el backend despliega
antes que la app. Al revés, una app nueva habla con un servidor que no la
entiende, y quien actualiza rápido se come el rato.

No hay que hacerlo en seco. Si algún paso no está en verde, se para ahí.

## 1 · La puerta de verificación, entera

Desde la raíz del repo:

```sh
(cd app           && npx tsc --noEmit)
(cd app           && bun run test)
(cd app/src-tauri && cargo check)
(cd backend       && go build ./... && go vet ./... && go test ./...)
```

Los cuatro. El CI también corre las pruebas por delante de lo que publica
(`backend.yml` antes de desplegar, `app.yml` antes de compilar la release; ver
`CLAUDE.md`), pero se pasan aquí primero: un rojo en el CI de la app deja una
versión publicada sin instaladores y ese número ya está gastado. Y el lado Rust
no tiene pruebas en el CI: `cargo check` es la única red. Ojo también: en local,
las pruebas del backend que necesitan Postgres se *saltan* sin `DB_HOST`, así que
un verde no quiere decir que se hayan corrido todas.

## 2 · Empujar, y esperar el verde del backend

```sh
git push
gh run watch --exit-status
```

Si el push tocó `backend/**`, `backend.yml` construye la imagen y **despliega a
k8s**. Hay que esperar a que termine en verde antes de seguir. Cortar la release
de la app mientras el backend está a medias es exactamente el fallo que este
orden evita.

Si no tocó `backend/**`, no hay nada que esperar: sáltate el paso 3 también.

## 3 · Sondear producción

Las rutas nuevas, contra `https://cac.guz-studio.dev`, sin credenciales:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://cac.guz-studio.dev/api/v1/<ruta-nueva>
```

**401, no 404.** Un 401 dice que la ruta existe y pide identificarse: el binario
nuevo está sirviendo. Un 404 dice que ese despliegue no llevaba la ruta, y
entonces el rollout no ha entrado todavía o falló sin decirlo.

**Y el proceso vivo es la prueba de que las migraciones pasaron**: si una
migración de GORM hubiera reventado, el pod no estaría contestando.

## 4 · Cortar la release, con la versión siguiente

**Antes de cortar, se pregunta a jose. Siempre.** Di qué versión sería y qué
lleva, y espera el sí. Mientras se trabaja van saliendo cosas pequeñas, y una
release cortada sin preguntar las deja fuera y obliga a otra de ~40 min (así
salió la v1.25.0, el 29-oct-2026). Commit, push y el despliegue del backend no
se preguntan; el corte, sí.

**Cuándo:** con una feature (o un plan de tandas) **terminada**, juntando lo
que haya, no por tanda. Una release son ~40 min de CI y obliga a todo el equipo
a actualizar. Un arreglo urgente de algo roto en producción sí sale solo.

**Qué número:** no se elige a mano, lo da el script.

```sh
scripts/next-version.sh     # imprime vX.Y.Z y el porqué
```

Versionado semántico sobre los prefijos de los commits desde la última
etiqueta:
- **algo que rompe** (`feat!:`, `BREAKING CHANGE`): la primera, 1.7.3 → 2.0.0;
- **algún `feat`**: la del medio, 1.7.3 → 1.8.0;
- **sólo arreglos**: la última, 1.7.3 → 1.7.4.

Hasta la v1.6.105 todo salió como parche, y el número no decía si una versión
traía algo nuevo. Lo guarda `app/src/lib/next-version.test.ts`.

La base es la etiqueta **más alta**, publicada o no. **Nunca se re-corta un
número gastado**: quien instaló la mala se queda tirado ahí, porque el
actualizador no le ofrece una versión que ya tiene. La v1.6.104 se canceló y
también cuenta como gastada.

**Nunca dejes un `gh release create` programado en segundo plano.** Se corta a
mano, después de comprobar los pasos 2 y 3. Una release cancelada que queda
marcada «Latest» sin `latest.json` deja **a todos sin actualizador**: se arregla
con `gh release edit <la-buena> --latest` y pasando la mala a borrador.

```sh
gh release create vX.Y.Z --title "C-C vX.Y.Z — <el titular>" --notes-file /tmp/notas.md
```

Publicar dispara `app-release.yml`: compila Linux, macOS y Windows **de uno en
uno** (~13 min de más, a propósito: en paralelo se pisan el `latest.json` y una
plataforma desaparece del índice del actualizador sin que nada salga rojo). Al
final, `verify-updater` comprueba que las **nueve claves** de plataforma —los
cuatro sabores de Linux, los dos de Windows y los tres de macOS— están en
`latest.json`.

Esperar también este verde:

```sh
gh run watch --exit-status
```

Una release con el índice incompleto se ve idéntica a una buena: todo verde,
todos los instaladores publicados, y el fallo aparece días después como un aviso
en la máquina de alguien.

## 5 · Las notas, en la voz del proyecto

**Qué cambia para quien usa la app, y por qué. No la lista de commits** — nadie
instala una app para leerse un historial.

La forma que ya tienen las releases de este repo:

- Un titular en negrita: la frase que resume el cambio, en presente.
- Lo que estaba mal antes, dicho sin rodeos y con la versión anterior nombrada.
- Lo que hay ahora, y qué se nota al usarlo.
- Si aplica: lo que **no** cambia, cuando eso es lo que la gente va a preguntar.

Léete `gh release view <tag-anterior> --json body` antes de escribir. En
castellano, como las demás.
