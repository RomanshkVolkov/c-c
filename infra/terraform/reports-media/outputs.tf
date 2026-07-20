output "bucket_name" {
  value       = aws_s3_bucket.media.bucket
  description = "Nombre del bucket S3 (para create-s3 en image-service)."
}

output "region" {
  value       = var.region
  description = "Región del bucket."
}

output "image_service_access_key_id" {
  value       = aws_iam_access_key.image_service.id
  description = "Access Key ID del usuario que usa image-service."
}

output "image_service_secret_access_key" {
  value       = aws_iam_access_key.image_service.secret
  sensitive   = true
  description = "Secret Access Key (sensible). Ver con: terraform output -raw image_service_secret_access_key"
}

# Comando listo para registrar el proyecto en image-service. Es sensible porque
# incluye el secret. Verlo con: terraform output -raw project_admin_command
# create-s3 imprime la API key en plano UNA sola vez → va a IMAGE_SERVICE_API_KEY
# del backend cac.
output "project_admin_command" {
  sensitive = true
  value = join(" ", [
    "project-admin create-s3 \"CAC Reports\" cac-reports",
    aws_iam_access_key.image_service.id,
    aws_iam_access_key.image_service.secret,
    var.region,
    aws_s3_bucket.media.bucket,
  ])
}
