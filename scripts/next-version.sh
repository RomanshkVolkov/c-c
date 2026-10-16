#!/usr/bin/env bash
# La versión siguiente de la app, según lo que trae desde la última etiqueta.
#
# Versionado semántico sobre los prefijos de los commits de este repo:
#   - un commit que rompe (`feat!:`, `fix(x)!:` o `BREAKING CHANGE` en el
#     cuerpo) sube la primera: 1.7.3 → 2.0.0;
#   - algún `feat` sube la del medio: 1.7.3 → 1.8.0;
#   - si no, sólo arreglos y demás, la última: 1.7.3 → 1.7.4.
#
# Hasta el 16-oct-2026 todo salía como parche (v1.6.0 → v1.6.105, la mayoría
# con funciones nuevas), y el número no decía si una versión traía algo nuevo.
# Lo usa la skill `/soltar`; ver `CLAUDE.md`, «Soltar una release».
#
# La base es la etiqueta **más alta**, publicada o no: un número que se gastó
# (como la v1.6.104, cancelada) no se vuelve a usar.
#
# Uso: scripts/next-version.sh [--no-fetch]   → imprime «vX.Y.Z» y el porqué.
set -euo pipefail

if [[ "${1:-}" != "--no-fetch" ]]; then
  git fetch --tags --quiet
fi

last=$(git tag --list 'v[0-9]*' --sort=-v:refname | head -1)
if [[ -z "$last" ]]; then
  echo "no hay ninguna etiqueta v*: la primera se elige a mano" >&2
  exit 1
fi
subjects=$(git log --format=%s "$last..HEAD")
if [[ -z "$subjects" ]]; then
  echo "nada nuevo desde $last" >&2
  exit 1
fi

IFS=. read -r major minor patch <<<"${last#v}"
patch=${patch%%[-+]*}
if grep -qE '^[a-z]+(\([^)]*\))?!:' <<<"$subjects" || git log --format=%b "$last..HEAD" | grep -q 'BREAKING CHANGE'; then
  next="$((major + 1)).0.0"
  why="algo rompe"
elif grep -qE '^feat(\([^)]*\))?:' <<<"$subjects"; then
  next="$major.$((minor + 1)).0"
  why="$(grep -cE '^feat(\([^)]*\))?:' <<<"$subjects") feat"
else
  next="$major.$minor.$((patch + 1))"
  why="sólo arreglos"
fi
echo "v$next"
echo "desde $last: $why ($(wc -l <<<"$subjects") commits)" >&2
