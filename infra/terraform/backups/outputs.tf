output "bucket_name" {
  value       = aws_s3_bucket.backups.bucket
  description = "BACKUPS_BUCKET del backend."
}

output "region" {
  value       = var.region
  description = "BACKUPS_REGION del backend."
}

output "prefix" {
  value       = var.prefix
  description = "BACKUPS_PREFIX del backend."
}

output "access_key_id" {
  value       = aws_iam_access_key.backups.id
  description = "BACKUPS_ACCESS_KEY_ID del backend."
}

output "secret_access_key" {
  value       = aws_iam_access_key.backups.secret
  sensitive   = true
  description = "BACKUPS_SECRET_ACCESS_KEY. Sólo por stdin: terraform output -raw secret_access_key | gh secret set …"
}
