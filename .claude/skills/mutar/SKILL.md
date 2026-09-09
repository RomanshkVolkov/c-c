---
name: mutar
description: Comprueba que una prueba prueba algo, rompiéndole el código a propósito. Úsala al escribir o revisar cualquier prueba de este repo, y cuando haya que decidir si una prueba existente sirve. Aplica mutantes de uno en uno, restaura siempre, y falla ruidosamente si el patrón no casa.
---

# Mutar

Una prueba que no se ha mutado no se sabe si prueba algo. El método de la casa es
escribir la prueba, romperle el código a propósito, y comprobar que la prueba se
queja. Es lo que ha encontrado los fallos de verdad aquí.

**La idea nunca falló; la mecánica sí, cuatro veces.** Por eso esto es una skill
con un script detrás y no un párrafo de instrucciones:

- Las comillas del shell lo tumbaron dos veces — un backtick, una línea con
  `const`. El texto del mutante viaja en un JSON y se aplica leyendo y
  escribiendo el fichero: ningún shell lo interpreta.
- Un patrón que **no casaba** dejaba puesto el mutante anterior y reportaba su
  resultado como si fuera el nuevo. Salieron conclusiones falsas de ahí.
- Un mutante que colgaba el proceso no imprimía nada, y había que decidir a mano
  si contaba como muerto.

## Cómo se usa

Escribe un plan en JSON (en `/tmp`, no en el repo) y pásalo al script. Desde la
raíz del repo:

```sh
python3 .claude/skills/mutar/mutar.py /tmp/plan.json
```

```json
{
  "test": "go test ./internal/core/domain/",
  "cwd": "backend",
  "timeout": 300,
  "mutants": [
    {
      "name": "una subtarea hereda el proyecto del padre",
      "file": "internal/core/domain/item.go",
      "find":    "if projectID != \"\" && v != VisibilityInternal {",
      "replace": "if projectID != \"\" {"
    }
  ]
}
```

- `cwd` es relativo a la raíz del repo; `file`, relativo a `cwd`.
- `find` tiene que casar **exactamente una vez** (o `times` veces, si lo pones).
  Copiar la línea del fichero tal cual suele bastar.
- `--only <nombre>` corre un mutante suelto.
- Las claves van en inglés y el `name` en castellano a propósito: el nombre es
  la frase que se lee en la tabla, no un identificador.

Para el lado TypeScript, lo mismo con `"cwd": "app"` y
`"test": "npx vitest run src/lib/mes.test.ts"`. Apunta el test **al fichero que
importa**: correr la suite entera por cada mutante multiplica la espera sin
añadir información.

## Lo que el script garantiza, y tú no tienes que vigilar

- **Línea base primero.** Si las pruebas no están en verde antes de mutar, aborta:
  mutar entonces daría a todos los mutantes por «muertos» por un fallo que ya
  estaba.
- **Un patrón que no casa es un error, no un veredicto.** Aborta y lo dice. Éste
  es el fallo que la skill viene a evitar.
- **Restaura siempre** — entre mutantes, al acabar, si algo revienta a medias, y
  con Ctrl-C.
- **Un cuelgue cuenta como muerto, pero se marca.** Una prueba que tarda infinito
  no es una prueba que falla.
- Saca una tabla de mutante → veredicto, y sale con código ≠ 0 si algo sobrevive.

Cuando acabe, **confirma con `git diff` que el árbol está limpio** antes de seguir.

## La regla que va con esto

**Un mutante vivo se investiga, no se ignora.**

Casi siempre es la prueba la que está mal, no el código — pasó con el prefijo
laxo de los enlaces y con el orden del guardado. A veces es un **mutante
equivalente**: el cambio no altera el comportamiento observable, así que ninguna
prueba podría cazarlo. Ése se anota como tal, en un comentario junto a la prueba,
en vez de inventarle una prueba que finja cubrirlo. Hay precedente escrito en
`app/src/store/meetings.store.ts`.

## Qué mutar

Lo que la prueba dice que protege, y de la forma más pequeña posible:

- Un guard: invertir la condición, o ponerla en `false`.
- Un límite: `>=` por `>`, quitar un `-1`.
- Un orden: intercambiar dos líneas cuyo orden importa.
- Un valor de vuelta: el código de error, el `nil` por un cero.
- Una fecha: el captador UTC por el local (ver `dueAt` en `CLAUDE.md`).

Un mutante que cambia algo que la prueba nunca miró no dice nada de la prueba.
