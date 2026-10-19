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

## Salir del sandbox

Una cuenta nueva de SES sólo envía a direcciones verificadas, y 200 al día.
Para mandar a cualquiera se pide acceso de producción (AWS contesta en ~24 h):
`aws sesv2 put-account-details` o la consola de SES → «Request production
access».

## Llevar las llaves al backend

Nunca a la pantalla: de `terraform output` a `gh secret set` por stdin.

```sh
gh secret set EMAIL_REGION            --body "$(terraform output -raw region)"
gh secret set EMAIL_FROM              --body "$(terraform output -raw from_address)"
gh secret set EMAIL_CONFIGURATION_SET --body "$(terraform output -raw configuration_set)"
gh secret set EMAIL_ACCESS_KEY_ID     --body "$(terraform output -raw access_key_id)"
terraform output -raw secret_access_key | gh secret set EMAIL_SECRET_ACCESS_KEY
```
