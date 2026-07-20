# Bucket privado para los screenshots de los reportes. Nada público: se sirve
# exclusivamente por el proxy autenticado del backend cac (sin CloudFront).
resource "aws_s3_bucket" "media" {
  bucket = var.bucket_name
  tags   = local.tags
}

# Bucket-owner enforced: sin ACLs (el objeto que sube image-service es del dueño
# del bucket).
resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Cierra TODO acceso público. No hay CDN ni lectura anónima: el único lector es
# el usuario IAM de image-service (y el backend a través de él).
resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Cifrado at-rest gestionado por S3 (SSE-S3). Los screenshots pueden contener PII.
resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Limpia uploads multiparte incompletos (defensa de costos), igual que marvi.
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
