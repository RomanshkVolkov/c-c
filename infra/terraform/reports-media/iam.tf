# Usuario dedicado que image-service usa para subir/leer objetos del bucket.
# Estas son las credenciales que se registran en image-service (project-admin
# create-s3). Calcado de marvi.
resource "aws_iam_user" "image_service" {
  name = "${var.bucket_name}-image-service"
  tags = local.tags
}

resource "aws_iam_access_key" "image_service" {
  user = aws_iam_user.image_service.name
}

data "aws_iam_policy_document" "image_service" {
  statement {
    sid = "ReportsMediaReadWrite"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.media.arn,
      "${aws_s3_bucket.media.arn}/*",
    ]
  }
}

resource "aws_iam_user_policy" "image_service" {
  name   = "${var.bucket_name}-image-service-policy"
  user   = aws_iam_user.image_service.name
  policy = data.aws_iam_policy_document.image_service.json
}
