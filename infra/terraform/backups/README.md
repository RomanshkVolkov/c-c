# Backups de bases de datos (#166)

El bucket donde el agente de cada servidor sube los backups, **ya cifrados con
age** para la llave de jose, por una URL firmada del backend. Ver `main.tf` para
el porqué de cada pieza.

## Aplicar

```sh
aws login
eval "$(aws configure export-credentials --format env)"
terraform init
terraform apply
```

## Llevar las llaves al backend

Nunca a la pantalla: de `terraform output` a `gh secret set` por stdin.

```sh
gh secret set BACKUPS_BUCKET            --body "$(terraform output -raw bucket_name)"
gh secret set BACKUPS_REGION            --body "$(terraform output -raw region)"
gh secret set BACKUPS_ACCESS_KEY_ID     --body "$(terraform output -raw access_key_id)"
terraform output -raw secret_access_key | gh secret set BACKUPS_SECRET_ACCESS_KEY
```

`backend.yml` las mete en `cac-secret`.

## Lo que no se puede deshacer

- `object_lock_enabled` no se apaga.
- Un objeto subido con una fecha de retención no se borra antes de esa fecha
  sin `BypassGovernanceRetention`, y cac no lo tiene.
