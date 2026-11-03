resource "aws_s3_bucket" "cnpg" {
  bucket = var.bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_ownership_controls" "cnpg" {
  bucket = aws_s3_bucket.cnpg.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "cnpg" {
  bucket                  = aws_s3_bucket.cnpg.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versionado: lo que barman borra por retención (o alguien por error) vive
# `deleted_versions_days` más como versión anterior. Es el margen para
# deshacer un borrado; no es un lock.
resource "aws_s3_bucket_versioning" "cnpg" {
  bucket = aws_s3_bucket.cnpg.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cnpg" {
  bucket = aws_s3_bucket.cnpg.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cnpg" {
  bucket = aws_s3_bucket.cnpg.id
  rule {
    id     = "cleanup"
    status = "Enabled"
    filter {}
    expiration {
      expired_object_delete_marker = true
    }
    noncurrent_version_expiration {
      noncurrent_days = var.deleted_versions_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  depends_on = [aws_s3_bucket_versioning.cnpg]
}
