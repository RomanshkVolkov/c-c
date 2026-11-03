# Backups del Postgres de gstd (CloudNativePG + plugin barman-cloud), en S3.
#
# Otro bucket que `guz-db-backups`, y a propósito sin Object Lock: aquél
# guarda los backups cifrados que sube el agente de cada servidor y nadie
# debe poder borrarlos antes de su fecha; aquí es barman quien escribe los
# base backups y el WAL y quien **borra por retención** (`retentionPolicy`
# del Cluster), y un lock se lo impediría. Lo que protege este bucket es la
# política IAM (sólo este usuario, sólo este bucket), el versionado con una
# semana de margen para lo borrado, y que la cuenta raíz es de jose.
#
# Decisión 178ba40d (3-nov-2026): S3 en la cuenta de jose, no Azure como
# pixel-vps. Un bucket por clúster; el prefijo es el nombre del servidor.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = var.profile != "" ? var.profile : null
}

locals {
  tags = {
    Project   = "cac"
    Component = "cnpg-backups"
    ManagedBy = "terraform"
  }
}
