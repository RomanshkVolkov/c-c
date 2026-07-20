# cac — reports-media infra (S3 privado) para los screenshots de los reportes.
#
# A diferencia de marvi (fotos públicas vía CloudFront/OAC), aquí los screenshots
# pueden contener datos de usuarios finales → el bucket queda 100% PRIVADO, SIN
# CloudFront. El único acceso es:
#   - image-service escribe/lee objetos con las llaves del usuario IAM (create-s3).
#   - el serving al cliente es EXCLUSIVAMENTE por proxy autenticado del backend cac.
# Ningún objeto es públicamente accesible ni hay CDN.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Credenciales por la cadena estándar de AWS (env / perfil / SSO). Opcionalmente
# se pueden pasar access_key/secret_key/profile por variables.
provider "aws" {
  region     = var.region
  profile    = var.profile != "" ? var.profile : null
  access_key = var.access_key != "" ? var.access_key : null
  secret_key = var.secret_key != "" ? var.secret_key : null
}

locals {
  tags = {
    Project   = "cac"
    Component = "reports-media"
    ManagedBy = "terraform"
  }
}
