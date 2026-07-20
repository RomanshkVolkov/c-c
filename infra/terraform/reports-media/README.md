# cac — reports-media (S3 privado, sin CDN)

Provisiona la infra para los **screenshots de los reportes** del tracker:

- **S3 privado** (`mx-central-1`, Querétaro) — acceso público bloqueado por completo.
- **Sin CloudFront**: los screenshots pueden contener datos de usuarios finales,
  así que **nunca** se sirven por CDN ni URL pública. El serving al cliente es
  exclusivamente por el **proxy autenticado del backend cac**.
- **Cifrado at-rest** (SSE-S3) y lifecycle que aborta multipart incompletos.
- **Usuario IAM** con llaves para que **image-service** haga los `PUT`/`GET`/`DELETE`
  (`project-admin create-s3`).

Un solo bucket para todas las organizaciones; los objetos se separan por prefijo
`org/<slug>/project/<slug>/…` (la key la decide el backend/image-service, no
Terraform). Separar buckets por org solo si algún día un cliente exige
aislamiento duro.

## Requisitos

- Terraform ≥ 1.6, credenciales AWS con permisos de S3/IAM
  (por `AWS_PROFILE` / env vars, o variables `access_key`/`secret_key`).

## Uso

```bash
cd infra/terraform/reports-media
cp terraform.tfvars.example terraform.tfvars   # ajusta bucket_name (único global)

terraform init
terraform plan
terraform apply
```

## Conectar con image-service y el backend

1. Registrar el proyecto en image-service con las credenciales generadas:

   ```bash
   terraform output -raw project_admin_command   # imprime el create-s3 completo
   # → project-admin create-s3 "CAC Reports" cac-reports <ACCESS> <SECRET> mx-central-1 guz-reports-media
   ```

   `create-s3` imprime la **API key en plano una sola vez** → guárdala.

2. En el backend de cac (`backend/.env` o el deploy) — mismo wiring que
   portento/marvi:

   ```
   IMAGE_SERVICE_URL=https://image-service.dwitmexico.com
   IMAGE_SERVICE_CERT_CN=cac-reports
   IMAGE_SERVICE_API_KEY=<api key impresa por create-s3>
   ```

   No hay `MEDIA_BASE_URL`: al no existir CDN, el backend sirve cada imagen por
   `GET /api/v1/reports/{id}/images/{imageID}` (proxy autenticado, scoping por
   report) y URLs firmadas cortas para el webview (ver Fase 3/4 del proposal).

## Notas

- El estado (`terraform.tfstate`) queda local por ahora — considera mover a un
  backend S3 remoto si más personas van a operar esta infra.
- `.terraform.lock.hcl` SÍ se commitea (pinnea la versión del provider AWS).
