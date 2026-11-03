# Backups del Postgres de gstd (CNPG → S3)

El bucket al que el plugin barman-cloud de CloudNativePG archiva el WAL y sube
el base backup diario del clúster `postgres` de gstd, y de donde se restaura.
Ver `main.tf` para el porqué de cada pieza (y por qué **no** lleva Object
Lock, a diferencia de `../backups`). Decisión 178ba40d.

## Aplicar

```sh
aws login
eval "$(aws configure export-credentials --format env)"
terraform init
terraform apply
```

## Llevar las llaves a 1Password, y de ahí a cac

Las llaves no van a GitHub ni al repo: a un ítem de 1Password en la bóveda
Private de jose, que la config del servidor en cac referencia (`opRefs`) y que
`infra/ansible` lee al correr `k8s` con `install_cnpg: true`. Nunca a la
pantalla: de `terraform output` a `op` por stdin.

```sh
op item create --category "API Credential" --vault Private --title "gstd cnpg s3" \
  "access_key_id=$(terraform output -raw access_key_id)" \
  "secret_access_key[password]=$(terraform output -raw secret_access_key)"
```

En cac (`set_server_config` o la app):

| Secreto | Referencia |
|---|---|
| `CNPG_S3_ACCESS_KEY_ID` | `op://Private/gstd cnpg s3/access_key_id` |
| `CNPG_S3_SECRET_ACCESS_KEY` | `op://Private/gstd cnpg s3/secret_access_key` |

Y las variables `cnpg_backup_bucket` y `cnpg_backup_region` con los outputs
`bucket_name` y `region`.

## Comprobar que sirve

Un backup que no se ha restaurado no es un backup: ver la subtarea
command-and-control-303 (restauración en un `Cluster` temporal con
`bootstrap.recovery` desde este bucket).
