# Desplegar desde cac: el aviso del CI

Cómo un repo que ya despliega con su propio CI pasa a que despliegue cac, sin
tener que hacerlo de golpe. GitHub sigue probando y construyendo la imagen; lo
que cambia es quién la pone en el servidor, y eso se decide por servicio y
cuando uno quiera.

> Contrato estable. Si algo de aquí no coincide con el comportamiento real, es
> un bug del documento o del código.

---

## 1. Los pasos, y qué se toca en cada uno

| Paso | Dónde | Qué cambia en el repo |
|---|---|---|
| 1. El servidor tiene el agente v3 | Servidores → «Update agent» | nada |
| 2. Registrar el servicio | Servicios → Deploy → «Registrar» | nada |
| 3. El CI avisa, en modo **Apuntar** | Deploy → «Acuñar llave» | un paso al final del workflow y el secret `CAC_DEPLOY_KEY` |
| 4. Pasar a modo **Desplegar** | Deploy → «Cuando el CI avisa» | quitar los pasos que despliegan por ssh |

Hasta el paso 3 incluido, el CI sigue desplegando igual que hoy: registrar un
servicio no toca el servidor, y en modo Apuntar cac sólo lleva la lista de las
versiones publicadas. Desde el paso 2 ya se puede desplegar un commit o volver
atrás a mano desde cac.

El agente actualiza el servicio con `service update` sobre la API de Docker,
**nunca** con `stack deploy`, así que un stack que creó el CI no se recrea y
conserva sus labels, redes y secrets. Por eso los pasos 3 y 4 pueden convivir
con un `prod.yml` a medio migrar.

## 2. La llave

Una por servicio registrado, en la cabecera `X-Deploy-Key`:

```
X-Deploy-Key: dk_...
```

- La acuña un **admin** de la org y se enseña **una vez**. De ella se guarda
  sólo un HMAC.
- Acuñar otra tumba la anterior en el momento.
- La llave es del servicio y el cuerpo no dice a cuál va: **no hay forma de
  desplegar otro servicio con ella**, ni de la misma org.
- Una llave que no casa (o sin cabecera) es un `401 invalid-deploy-key`, sin más
  detalle.
- 60 avisos por hora por servicio; el 61 es un `429 rate-limited`.

## 3. El paso del workflow

Después del paso que publica la imagen:

```yaml
      - name: Notify cac
        run: |
          curl -fsS -X POST https://cac.guz-studio.dev/ingest/v1/deploys \
            -H "X-Deploy-Key: ${{ secrets.CAC_DEPLOY_KEY }}" \
            -H "Content-Type: application/json" \
            -d "{\"sha\":\"$GITHUB_SHA\",\"ref\":\"$GITHUB_REF\",\"actor\":\"$GITHUB_ACTOR\",\"runUrl\":\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\"}"
```

La app enseña este mismo paso al acuñar la llave, listo para copiar.

**El sha tiene que ser el tag de la imagen.** cac despliega `imageRepo:sha` y
nada más: no hay campo de imagen en el aviso, justamente para que una llave
filtrada no pueda desplegar una imagen de otro sitio. Si el workflow etiqueta con
el sha corto, manda el corto.

## 4. La respuesta

```json
{ "success": true, "data": { "build": { ... }, "deploy": "queued", "reason": "", "deployment": { ... } } }
```

| `deploy` | HTTP | Qué pasó |
|---|---|---|
| `recorded` | 200 | Modo Apuntar: el build queda en la lista y no se despliega nada. |
| `queued` | 202 | Modo Desplegar: el agente lo recogerá en su siguiente pregunta (segundos). |
| `exists` | 200 | Ya había un deploy de ese commit por aviso del CI (un reintento): no se duplica. |
| `skipped` | 200 | No se pudo encolar ahora; `reason` dice por qué. El build sí queda. |

Los `reason` de un `skipped`:

- `deploy-in-flight`: ya hay otro deploy del servicio en cola o en curso. Pasa
  con dos commits seguidos. El segundo queda en la lista y se despliega desde ahí.
- `agent-too-old`: el agente del servidor no sabe desplegar. Hay que
  reinstalarlo.

Un `skipped` **no pone el CI en rojo** a propósito: rojo diría que algo del
repo está roto, y no lo está. El resultado del deploy se ve en cac, con su
log en vivo y quién lo pidió («el CI»).

El mismo sha dos veces es un build y, como mucho, un deploy: los reintentos del
workflow no despliegan dos veces.

## 5. Lo que no hace (todavía)

- No sabe de ramas: despliega lo que el workflow avise. Si el paso sólo corre en
  `main`, sólo se despliega `main`.
- Con la [GitHub App](github.md) instalada y el workflow que publica la imagen
  puesto en el servicio, este paso **sobra**: el final de ese workflow cuenta
  como el aviso. Y cada deploy aparece en GitHub como un Deployment.
- Los secrets del servicio siguen siendo los que ya tenga el servicio. Los
  secrets gestionados por cac piden el modo Desplegar, porque un `stack deploy`
  del CI los tiraría.
