terraform {
  required_version = ">= 1.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# DO NOT APPLY without reconciling state first (verified 2026-09-23):
# - The DynamoDB tables below, in this module's us-east-1 state, were the
#   pre-migration copies and were DELETED on 2026-09-23. The live tables are in
#   ap-southeast-2 and in no terraform state. An apply here recreates empty
#   us-east-1 tables; it does not manage production data.
# - The live SQS grant on ai-tutor-ec2-ssm-role is a separate inline policy,
#   `ai-tutor-sqs-jobs` (ChangeMessageVisibility applied by CLI 2026-09-23),
#   not the SQSJobQueues statement below. Applying would add a second grant.
# - `ai-tutor-bedrock-inference-profiles` (below) was created by CLI on
#   2026-09-23. Import it before any apply:
#     terraform import aws_iam_role_policy.ec2_bedrock_inference_profiles ai-tutor-ec2-ssm-role:ai-tutor-bedrock-inference-profiles

# ─────────────────────────────────────────────────────────────
# DynamoDB — oral_assessments (single-table for all assessment data)
#
# Item types stored here:
#   ASSESSMENT#<id> / METADATA       — assessment metadata
#   STUDENT#<id>#ASSESSMENT#<id> / QUESTION#<id>    — per-student questions
#   STUDENT#<id>#ASSESSMENT#<id> / ANSWER#<id>      — student answers
#   STUDENT#<id>#ASSESSMENT#<id> / PROGRESS         — submission progress
#   STUDENT#<id>#ASSESSMENT#<id> / EVALUATION#<id>  — AI evaluation results
#   STUDENT#<id>#ASSESSMENT#<id> / EVAL_PROGRESS    — live evaluation progress
#   JOB#<id> / METADATA                             — batch job state (7-day TTL)
# ─────────────────────────────────────────────────────────────

resource "aws_dynamodb_table" "oral_assessments" {
  name         = var.assessment_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  # GSI: look up all assessments created by an instructor
  attribute {
    name = "GSI1PK"
    type = "S" # INSTRUCTOR#<id>
  }

  attribute {
    name = "GSI1SK"
    type = "S" # STATUS#ASSESSMENT#<id>  — allows filtering by status
  }

  global_secondary_index {
    name            = "InstructorAssessmentsIndex"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  # TTL attribute used by JOB# items (7-day auto-expiry)
  ttl {
    enabled        = true
    attribute_name = "TTL"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = merge(var.tags, {
    Name = "oral-assessments"
  })
}

# ─────────────────────────────────────────────────────────────
# DynamoDB — auth_users (shared auth table for instructors)
# Skip if this table already exists in your account.
# ─────────────────────────────────────────────────────────────

resource "aws_dynamodb_table" "auth_users" {
  name         = var.auth_users_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "email"

  attribute {
    name = "email"
    type = "S"
  }

  tags = merge(var.tags, {
    Name = "auth-users"
  })

  lifecycle {
    # Prevent accidental deletion of user auth records
    prevent_destroy = true
    # Ignore tag drift — tags were added by Terraform but the table predates this module
    ignore_changes = [tags]
  }
}

# ─────────────────────────────────────────────────────────────
# S3 — assessment-files (private; presigned URL access only)
#
# Stores: student audio/video recordings, transcripts, evaluation reports
# ─────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "assessment_files" {
  bucket = var.assessment_files_bucket
  tags   = merge(var.tags, { Name = "assessment-files" })
}

resource "aws_s3_bucket_public_access_block" "assessment_files" {
  bucket = aws_s3_bucket.assessment_files.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "assessment_files" {
  bucket = aws_s3_bucket.assessment_files.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "DELETE", "HEAD"]
    allowed_origins = var.allowed_cors_origins
    expose_headers  = ["ETag", "Content-Length"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "assessment_files" {
  bucket = aws_s3_bucket.assessment_files.id

  # Move audio/video to Infrequent Access after 30 days, expire after 1 year
  rule {
    id     = "archive-old-recordings"
    status = "Enabled"

    filter {
      prefix = "recordings/"
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    expiration {
      days = 365
    }
  }
}

# ─────────────────────────────────────────────────────────────
# S3 — instructor frontend static site
# ─────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "instructor_app" {
  bucket = var.instructor_app_bucket
  tags   = merge(var.tags, { Name = "instructor-app" })
}

resource "aws_s3_bucket_website_configuration" "instructor_app" {
  bucket = aws_s3_bucket.instructor_app.id

  index_document { suffix = "index.html" }
  error_document { key = "index.html" } # SPA fallback
}

resource "aws_s3_bucket_public_access_block" "instructor_app" {
  bucket = aws_s3_bucket.instructor_app.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "instructor_app" {
  bucket     = aws_s3_bucket.instructor_app.id
  depends_on = [aws_s3_bucket_public_access_block.instructor_app]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadGetObject"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = ["${aws_s3_bucket.instructor_app.arn}/*"]
    }]
  })
}

# ─────────────────────────────────────────────────────────────
# S3 — student frontend static site
# ─────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "student_app" {
  bucket = var.student_app_bucket
  tags   = merge(var.tags, { Name = "student-app" })
}

resource "aws_s3_bucket_website_configuration" "student_app" {
  bucket = aws_s3_bucket.student_app.id

  index_document { suffix = "index.html" }
  error_document { key = "index.html" } # SPA fallback
}

resource "aws_s3_bucket_public_access_block" "student_app" {
  bucket = aws_s3_bucket.student_app.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "student_app" {
  bucket     = aws_s3_bucket.student_app.id
  depends_on = [aws_s3_bucket_public_access_block.student_app]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadGetObject"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject"]
      Resource  = ["${aws_s3_bucket.student_app.arn}/*"]
    }]
  })
}

# ─────────────────────────────────────────────────────────────
# SES — domain identity for sending assessment invitation emails
#
# After apply, add the output DNS records to Cloudflare, then
# run `terraform apply` again — Terraform will wait for verification.
# ─────────────────────────────────────────────────────────────

resource "aws_ses_domain_identity" "main" {
  domain = var.ses_domain
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

# Configure mail-from subdomain (improves deliverability + SPF alignment)
resource "aws_ses_domain_mail_from" "main" {
  domain           = aws_ses_domain_identity.main.domain
  mail_from_domain = "mail.${var.ses_domain}"
}

# ─────────────────────────────────────────────────────────────
# IAM — extend existing EC2 role with assessment resource access
# ─────────────────────────────────────────────────────────────

resource "aws_iam_role_policy" "ec2_assessment" {
  name = "ai-tutor-assessment-access"
  role = var.ec2_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # DynamoDB — oral assessments table
      {
        Sid    = "OralAssessmentsDynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchWriteItem",
          "dynamodb:BatchGetItem",
          "dynamodb:DescribeTable",
        ]
        Resource = [
          aws_dynamodb_table.oral_assessments.arn,
          "${aws_dynamodb_table.oral_assessments.arn}/index/*",
          aws_dynamodb_table.auth_users.arn,
          "${aws_dynamodb_table.auth_users.arn}/index/*",
        ]
      },
      # S3 — assessment files bucket (presigned URL generation + direct writes)
      {
        Sid    = "AssessmentFilesBucket"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:GetObjectAttributes",
        ]
        Resource = [
          aws_s3_bucket.assessment_files.arn,
          "${aws_s3_bucket.assessment_files.arn}/*",
        ]
      },
      # SES — send assessment invitation and reminder emails
      {
        Sid    = "SESEmail"
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail",
        ]
        Resource = [
          "arn:aws:ses:${var.aws_region}:*:identity/${var.ses_domain}",
          "arn:aws:ses:${var.aws_region}:*:identity/mail.${var.ses_domain}",
        ]
      },
      # Bedrock — LLM inference for question generation and response evaluation
      {
        Sid    = "BedrockInference"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = [
          "arn:aws:bedrock:${var.aws_region}::foundation-model/*",
        ]
      },
      # SSM Parameter Store — read app config and secrets at deploy/startup time
      # (AmazonSSMManagedInstanceCore only grants SSM session access, not GetParameter)
      {
        Sid    = "SSMParameterRead"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
        ]
        Resource = "arn:aws:ssm:*:*:parameter/ai-tutor/*"
      },
      # SQS — send and receive job messages for async evaluation/question generation
      {
        Sid    = "SQSJobQueues"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          # Heartbeat and retry backoff in SQSJobDispatcher. Without it both are
          # AccessDenied, logged only, and retries wait the full visibility timeout.
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
        ]
        Resource = [
          aws_sqs_queue.jobs.arn,
          aws_sqs_queue.jobs_dlq.arn,
        ]
      },
    ]
  })
}

data "aws_caller_identity" "current" {}

# Chat runs on the us. cross-region inference profile for Nova 2 Lite, which
# needs the profile ARN plus the model in every region the profile routes to.
# Marking stays on the on-demand Nova Lite model covered by BedrockInference.
resource "aws_iam_role_policy" "ec2_bedrock_inference_profiles" {
  name = "ai-tutor-bedrock-inference-profiles"
  role = var.ec2_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "NovaTwoLiteCrossRegion"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = [
          "arn:aws:bedrock:us-east-1:${data.aws_caller_identity.current.account_id}:inference-profile/us.amazon.nova-2-lite-v1:0",
          "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-lite-v1:0",
          "arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-2-lite-v1:0",
          "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-2-lite-v1:0",
        ]
      },
    ]
  })
}

# ─────────────────────────────────────────────────────────────
# SQS — job queues for async evaluation and question generation
#
# Workers (running on EC2) poll ai-tutor-jobs; messages that
# fail maxReceiveCount times move to the DLQ for alerting.
# ─────────────────────────────────────────────────────────────

# IMPORT NEEDED: the live ai-tutor-jobs queue and DLQ exist in us-east-1 (the
# app consumes them via SSM /ai-tutor/prod/SQS_JOBS_QUEUE_URL) but were created
# outside terraform — neither is in this module's state, only the DLQ alarm
# below is. With credentials that have sqs:GetQueueAttributes, run:
#   terraform import aws_sqs_queue.jobs_dlq https://sqs.us-east-1.amazonaws.com/339712753655/ai-tutor-jobs-dlq
#   terraform import aws_sqs_queue.jobs     https://sqs.us-east-1.amazonaws.com/339712753655/ai-tutor-jobs
# then `terraform plan` — the settings declared here (300s visibility, 1-day
# retention) may differ from the hand-created queue; reconcile before applying.
resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "ai-tutor-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days

  tags = merge(var.tags, { Name = "ai-tutor-jobs-dlq" })
}

resource "aws_sqs_queue" "jobs" {
  name                       = "ai-tutor-jobs"
  visibility_timeout_seconds = 300   # 5 min — matches max evaluation runtime
  message_retention_seconds  = 86400 # 1 day

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 3
  })

  tags = merge(var.tags, { Name = "ai-tutor-jobs" })
}

# ─────────────────────────────────────────────────────────────
# CloudWatch — DLQ depth alarm (messages in DLQ = failed jobs)
# ─────────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "ai-tutor-jobs-dlq-has-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Evaluation or question-generation job moved to DLQ — check CloudWatch logs"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.jobs_dlq.name
  }

  tags = var.tags
}
