variable "region" {
  type        = string
  default     = "mx-central-1" # Querétaro, como reports-media.
  description = "Región AWS del bucket."
}

variable "profile" {
  type        = string
  default     = ""
  description = "Perfil de AWS CLI (opcional; si vacío usa la cadena estándar)."
}

variable "bucket_name" {
  type        = string
  default     = "guz-db-backups"
  description = "Nombre del bucket (globalmente único)."
}

variable "prefix" {
  type        = string
  default     = "backups"
  description = "Prefijo de los objetos. Tiene que coincidir con el del backend: la política IAM se acota a él."
}

variable "default_retention_days" {
  type        = number
  default     = 1
  description = "Suelo de la retención: lo mínimo que vive un objeto aunque la subida no diga nada. La de verdad la pone cada subida."
}
