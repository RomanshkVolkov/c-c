---
name: cac-consolidar
description: Pasa por lo que entró en cac en la última semana (tareas cerradas, notas de agentes, decisiones, docs editados) y propone qué sube a «Trampas que ya han mordido», qué decisión falta registrar, qué sección del runbook quedó vieja y qué páginas se duplican. No escribe nada hasta que el usuario aprueba. Úsala cuando digan «consolida», «limpia cac», «qué se nos quedó sin apuntar», o una vez por semana por espacio.
---

# Consolidar cac

La memoria sin un bucle de limpieza se llena de duplicados y de cosas viejas.
Lo que entra en cac —comentarios de tareas, notas de agentes, decisiones,
páginas— nadie lo vuelve a mirar. Esta skill es ese bucle, **a mano**: lee,
propone, y sólo escribe lo que el usuario apruebe.

Decidido con jose el 22-oct-2026 (registro de decisiones de Command and
control): primero manual; programada cuando haya demostrado que sirve.

## 1 · Qué leer

Con `get_context` del espacio, y `since` de hace siete días (o desde la última
consolidación, si el usuario la nombra):

- `changes.tasks`: las que pasaron a hechas o cerradas. De cada una, `get_task`
  y leer el `handoff` y los comentarios de personas y agentes (los avisos de
  commit no vienen).
- La página **«Notas de agentes»** del espacio (`get_doc_page`, o `search`
  «notas de agentes»): lo que los agentes apuntaron con `remember`.
- `changes.decisions` y `changes.docs`: lo que ya se registró y se editó, para
  no proponerlo dos veces.
- La sección **«Trampas que ya han mordido»** y el runbook del nodo, para
  comparar.

No leas más que eso. Una consolidación que se lee el espacio entero no se
vuelve a hacer.

## 2 · Qué proponer

Una lista corta, agrupada así, cada punto con **de dónde sale** (la tarea, la
nota, la fecha) y **el texto propuesto** tal cual iría:

1. **Sube a «Trampas que ya han mordido».** Algo que mordió a alguien y le
   morderá al siguiente: un fallo de plataforma, un comportamiento no
   documentado, una suposición que resultó falsa. Tres o cuatro líneas: qué
   pasó, por qué, y qué prueba lo guarda si la hay. Una nota de agente que
   lo cuenta es candidata; un dato medido sin moraleja, no.
2. **Falta una decisión.** Un comentario o handoff que dice «decidimos»,
   «jose prefiere», «se descarta», y no hay entrada en el registro. Proponer
   título, porqué y `decidedBy`. Si cambia una decisión vigente, decir cuál
   (`supersedes`).
3. **El runbook quedó viejo.** Un comando, una variable, un paso que un
   handoff o una nota dicen que ya no es así. Proponer la sección y el texto.
4. **Se duplica.** Dos páginas o una página y un `.md` del repo que dicen lo
   mismo (el mapa marca las copias exactas con `mirrorOf`; las parecidas hay
   que leerlas). Proponer cuál manda: el repo, si está ahí.
5. **Notas que ya cumplieron.** Líneas de «Notas de agentes» que subieron a
   Trampas o al runbook: proponer quitarlas de la página, para que no crezca
   sin fin.

Lo que no entra en ninguna, no se propone. Una consolidación vacía («no hay
nada que subir») es una respuesta válida y corta.

## 3 · Cómo escribir, después del sí

Sólo lo aprobado, punto por punto, con las herramientas de siempre:

- Trampas: `write_doc_section` sobre «Trampas que ya han mordido» del nodo,
  con el `sectionHash` leído; si el nodo no la tiene, `append_doc_tab` en el
  overview.
- Decisiones: `record_decision` con `originTaskId` y `decidedBy`.
- Runbook: `write_doc_section` con su `sectionHash`.
- Notas cumplidas: reescribir la página «Notas de agentes» sin esas líneas
  (`write_doc_page` con su `bodyHash`).

Y una línea en «Notas de agentes» al final: «Consolidado el <fecha>: N trampas,
N decisiones, N secciones», para que la siguiente sepa desde cuándo mirar.

<!-- cac-consolidar v1 -->
