variable "region" {
  type        = string
  default     = "us-east-1"
  description = "Región de SES. La del rebote (feedback-smtp.<región>.amazonses.com) sale de aquí."
}

variable "profile" {
  type        = string
  default     = ""
  description = "Perfil de AWS CLI (opcional; si vacío usa la cadena estándar)."
}

variable "domain" {
  type        = string
  default     = "guz-studio.dev"
  description = "El dominio desde el que se envía."
}

variable "mail_from_subdomain" {
  type        = string
  default     = "mail"
  description = "Subdominio del rebote (MAIL FROM). Lleva su propio MX y SPF hacia SES; el dominio raíz se queda con los de Zoho."
}

variable "from_address" {
  type        = string
  default     = "no-reply@guz-studio.dev"
  description = "La única dirección desde la que las llaves de cac pueden enviar."
}

variable "alerts_email" {
  type        = string
  default     = "jose@guz-studio.dev"
  description = "A quién le llega cada rebote, queja o rechazo de los correos de cac (notifications.tf)."
}
