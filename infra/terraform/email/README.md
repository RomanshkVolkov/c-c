# Correo del backend (Amazon SES)

Lo que manda cac: la bienvenida de una cuenta nueva y restablecer la
contraseña. Ver `main.tf` para el porqué de cada pieza.

## Aplicar

```sh
aws login
eval "$(aws configure export-credentials --format env)"
terraform init
terraform apply
```

## Los registros en Cloudflare

```sh
terraform output dns_records
```

Todos **sin proxy** (nube gris). Son tres CNAME de DKIM, el MX y el SPF del
subdominio del rebote, y el DMARC. El MX y el SPF del dominio raíz (los de Zoho)
no se tocan. SES verifica solo en unos minutos:

```sh
aws sesv2 get-email-identity --email-identity guz-studio.dev \
  --query '{dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}'
```

## Avisos de lo que sale mal

Cada rebote, queja, rechazo, fallo de plantilla o retraso de los correos de cac
va al tema SNS `cac-ses-events`, y de ahí a `alerts_email` (ver
`notifications.tf`). La suscripción se confirma **una vez** con el enlace que
manda AWS; hasta entonces no llega nada.

Para probarlo sin molestar a nadie, el simulador de SES (funciona también en el
sandbox) — debe llegar el aviso de un rebote:

```sh
aws sesv2 send-email --region us-east-1 --configuration-set-name cac \
  --from-email-address no-responder@guz-studio.dev \
  --destination ToAddresses=bounce@simulator.amazonses.com \
  --content 'Simple={Subject={Data=prueba},Body={Text={Data=prueba}}}'
```

## Salir del sandbox

Una cuenta nueva de SES sólo envía a direcciones verificadas, y 200 al día.
Para mandar a cualquiera se pide acceso de producción (AWS contesta en ~24 h):
`aws sesv2 put-account-details` o la consola de SES → «Request production
access».

## Llevar las llaves al backend

Nunca a la pantalla: de `terraform output` a `gh secret set` por stdin.

```sh
gh variable set EMAIL_REGION            --body "$(terraform output -raw region)"
gh variable set EMAIL_FROM              --body "$(terraform output -raw from_address)"
gh variable set EMAIL_CONFIGURATION_SET --body "$(terraform output -raw configuration_set)"
terraform output -raw access_key_id     | gh secret set EMAIL_ACCESS_KEY_ID
terraform output -raw secret_access_key | gh secret set EMAIL_SECRET_ACCESS_KEY
```

`backend.yml` las mete en `cac-secret`. Sin `EMAIL_REGION` o `EMAIL_FROM` el
correo queda apagado: el alta le da el enlace al admin y restablecer contesta
`email-off`.
