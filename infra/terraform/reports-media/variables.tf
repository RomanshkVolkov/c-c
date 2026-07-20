variable "region" {
  type        = string
  default     = "mx-central-1" # AWS México Central (Querétaro), igual que marvi.
  description = "Región AWS del bucket."
}

variable "profile" {
  type        = string
  default     = ""
  description = "Perfil de AWS CLI a usar (opcional; si vacío usa la cadena estándar de credenciales)."
}

variable "access_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "AWS access key (opcional; preferible usar la cadena estándar / perfil)."
}

variable "secret_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "AWS secret key (opcional)."
}

variable "bucket_name" {
  type        = string
  default     = "guz-reports-media"
  description = "Nombre del bucket S3 (debe ser globalmente único). Un solo bucket para todas las orgs; los objetos se prefijan org/<slug>/project/<slug>/…"
}
