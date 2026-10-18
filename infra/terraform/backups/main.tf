# cac — backups de bases de datos (#166).
#
# Un bucket aparte del de los medios, porque las reglas son otras: lo que se
# guarda aquí no se puede borrar antes de tiempo **ni con las llaves de cac**.
# Object Lock en modo GOVERNANCE, con la fecha de cada objeto puesta por la
# subida (la decide el backend según la retención de la base). Quien entre a cac
# con sus llaves puede subir backups nuevos, pero no hacer desaparecer los que
# hay: sólo quien tenga `BypassGovernanceRetention`, que es la cuenta raíz.
#
# Los backups llegan ya cifrados con age para la llave de jose: ni este bucket
# ni AWS pueden leer su contenido. El SSE-S3 de abajo es una capa más.
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
    Component = "db-backups"
    ManagedBy = "terraform"
  }
}
