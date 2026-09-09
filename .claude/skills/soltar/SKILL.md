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

Los cuatro. **El CI no corre ninguna prueba** (ver `CLAUDE.md`), así que esto es
la única red que hay. Y ojo: las pruebas del backend que necesitan Postgres se
*saltan* sin base, así que un verde no quiere decir que se hayan corrido todas.

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

```sh
git tag --sort=-v:refname | head -3     # de dónde se viene
```

La versión es la **siguiente**. **Nunca se re-corta una publicada**: quien
instaló la mala se queda tirado ahí, porque el actualizador no le ofrece una
versión que ya tiene.

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
