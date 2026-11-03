variable "region" {
  type        = string
  default     = "mx-central-1" # Querétaro, como todo lo de cac.
  description = "Región AWS del bucket."
}

variable "profile" {
  type        = string
  default     = ""
  description = "Perfil de AWS CLI (opcional; si vacío usa la cadena estándar)."
}

variable "bucket_name" {
  type        = string
  default     = "guz-cnpg-backups"
  description = "Nombre del bucket (globalmente único)."
}

variable "deleted_versions_days" {
  type        = number
  default     = 7
  description = "Cuántos días vive una versión anterior (lo que barman borró por retención, o alguien por error) antes de irse del todo."
}
