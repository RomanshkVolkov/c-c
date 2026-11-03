output "bucket_name" {
  value       = aws_s3_bucket.cnpg.bucket
  description = "cnpg_backup_bucket de la config del servidor en cac."
}

output "region" {
  value       = var.region
  description = "cnpg_backup_region de la config del servidor en cac."
}

output "access_key_id" {
  value       = aws_iam_access_key.cnpg.id
  description = "Va a 1Password (campo access_key_id del ítem del servidor)."
}

output "secret_access_key" {
  value       = aws_iam_access_key.cnpg.secret
  sensitive   = true
  description = "Sólo por stdin a 1Password: terraform output -raw secret_access_key | op item edit …"
}
