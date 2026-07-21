terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
  backend "s3" {
    bucket         = "stellarglobalsupplies-backend-config"
    key            = "stellar-global-workflow/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "stellarglobalsupplies-backend-db-config"
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "workflows-platform"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ─────────────────────────────────────────────
# DATA
# ─────────────────────────────────────────────
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  prefix     = "${var.project_name}-${var.environment}"
}

# ─────────────────────────────────────────────
# S3 BUCKETS
# ─────────────────────────────────────────────
resource "aws_s3_bucket" "frontend" {
  bucket = "${local.prefix}-frontend"
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "assets" {
  bucket = "${local.prefix}-assets"
}

resource "aws_s3_bucket_cors_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["https://${var.workflow_domain}", "http://localhost:5173"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront OAC for assets
resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = "${local.prefix}-assets-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront distribution for assets
resource "aws_cloudfront_distribution" "assets" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.assets_domain]
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = "S3-assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }

  default_cache_behavior {
    target_origin_id       = "S3-assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# Bucket policy allowing CloudFront OAC to access assets
resource "aws_s3_bucket_policy" "assets_cloudfront" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontServicePrincipal"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.assets.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.assets.arn
        }
      }
    }]
  })
}

# Context bucket is referenced by name (may not exist yet)

# ─────────────────────────────────────────────
# CLOUDFRONT OAC for frontend
# ─────────────────────────────────────────────
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.prefix}-frontend-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.workflow_domain]
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "S3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id       = "S3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # SPA fallback - return index.html for all 404s
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_s3_bucket_policy" "frontend_oac" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontServicePrincipal"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.frontend.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
        }
      }
    }]
  })
}

# ─────────────────────────────────────────────
# ROUTE 53
# ─────────────────────────────────────────────
data "aws_route53_zone" "main" {
  name = var.root_domain
}

resource "aws_route53_record" "workflow" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.workflow_domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

# ─────────────────────────────────────────────
# IAM - Lambda execution role
# ─────────────────────────────────────────────
resource "aws_iam_role" "lambda_exec" {
  name = "${local.prefix}-lambda-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda_policy" {
  name = "${local.prefix}-lambda-policy"
  role = aws_iam_role.lambda_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Sid    = "S3Assets"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.assets.arn,
          "${aws_s3_bucket.assets.arn}/*",
        ]
      },
      {
        Sid      = "Bedrock"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      },
      {
        Sid      = "StepFunctions"
        Effect   = "Allow"
        Action   = ["states:StartExecution", "states:SendTaskSuccess", "states:SendTaskFailure", "states:DescribeExecution"]
        Resource = "*"
      },
      {
        Sid      = "SSM"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:${local.region}:${local.account_id}:parameter/${var.project_name}/*"
      },
      {
        Sid    = "EventBridge"
        Effect = "Allow"
        Action = [
          "events:PutRule",
          "events:PutTargets",
          "events:DeleteRule",
          "events:RemoveTargets",
          "events:EnableRule",
          "events:DisableRule",
          "events:DescribeRule",
          "events:ListTargetsByRule",
        ]
        Resource = "*"
      },
      {
        Sid      = "PassRoleToEvents"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.events_sfn.arn
      }
    ]
  })
}

# ─────────────────────────────────────────────
# IAM - Step Functions execution role
# ─────────────────────────────────────────────
resource "aws_iam_role" "sfn_exec" {
  name = "${local.prefix}-sfn-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "sfn_policy" {
  name = "${local.prefix}-sfn-policy"
  role = aws_iam_role.sfn_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = "arn:aws:lambda:${local.region}:${local.account_id}:function:${local.prefix}-*"
    }]
  })
}

# IAM role for EventBridge to trigger Step Functions
resource "aws_iam_role" "events_sfn" {
  name = "${local.prefix}-events-sfn"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "events_sfn_policy" {
  name = "${local.prefix}-events-sfn-policy"
  role = aws_iam_role.events_sfn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "states:StartExecution"
      Resource = "*"
    }]
  })
}

# ─────────────────────────────────────────────
# LAMBDA FUNCTIONS
# ─────────────────────────────────────────────
locals {
  lambda_env = {
    SUPABASE_URL          = var.supabase_url
    SUPABASE_SERVICE_KEY  = var.supabase_service_key
    ASSETS_BUCKET         = aws_s3_bucket.assets.bucket
    ASSETS_CLOUDFRONT_URL = "https://${aws_cloudfront_distribution.assets.domain_name}"
    CONTEXT_BUCKET        = var.context_bucket
    BEDROCK_TEXT_MODEL    = "amazon.nova-pro-v1:0"
    # BEDROCK_IMAGE_MODEL       = "amazon.nova-canvas-v1:0"
    # BEDROCK_IMAGE_MODEL_FALLBACK = "amazon.titan-image-generator-v2:0"
    SENDER_EMAIL              = var.sender_email
    GMAIL_CLIENT_ID_PARAM     = "/${var.project_name}/gmail/client_id"
    GMAIL_CLIENT_SECRET_PARAM = "/${var.project_name}/gmail/client_secret"
    GMAIL_REFRESH_TOKEN_PARAM = "/${var.project_name}/gmail/refresh_token"
    FB_PAGE_ID_PARAM          = "/${var.project_name}/facebook/page_id"
    FB_ACCESS_TOKEN_PARAM     = "/${var.project_name}/facebook/access_token"
    IG_ACCOUNT_ID_PARAM       = "/${var.project_name}/instagram/account_id"
    IG_ACCESS_TOKEN_PARAM     = "/${var.project_name}/instagram/access_token"
    GITHUB_TOKEN_PARAM        = "/${var.project_name}/github/token"
    WEBSITE_REPO_OWNER        = "Stellar-Global-Supplies"
    WEBSITE_REPO_NAME         = "stellarglobalsupplies-website"
    WEBSITE_BASE_BRANCH       = "main"
    WEBSITE_BLOG_DIR          = "content/blog"
    EVENTS_ROLE_ARN           = aws_iam_role.events_sfn.arn
    HUNTER_API_KEY_PARAM      = "/${var.project_name}/hunter/api_key"
    LINKEDIN_NOTIFY_EMAILS             = var.linkedin_notify_emails
    SEND_PAYMENT_EMAIL_FUNCTION_NAME   = "${local.prefix}-send-payment-email"
  }

  lambdas = {
    generate-leads      = { handler = "lead_generation.generate_leads.handler", source = "../backend/lambdas" }
    load-lead-for-email = { handler = "lead_generation.load_lead_for_email.handler", source = "../backend/lambdas" }
    check-duplicate     = { handler = "lead_generation.check_duplicate.handler", source = "../backend/lambdas" }
    save-lead           = { handler = "lead_generation.save_lead.handler", source = "../backend/lambdas" }
    draft-email         = { handler = "lead_generation.draft_email.handler", source = "../backend/lambdas" }
    create-approval     = { handler = "lead_generation.create_approval.handler", source = "../backend/lambdas" }
    send-email          = { handler = "lead_generation.send_email.handler", source = "../backend/lambdas" }
    schedule-followup   = { handler = "lead_generation.schedule_followup.handler", source = "../backend/lambdas" }
    get-orders          = { handler = "social_media.get_orders.handler", source = "../backend/lambdas" }
    generate-post       = { handler = "social_media.generate_post.handler", source = "../backend/lambdas" }
    post-to-platforms   = { handler = "social_media.post_to_platforms.handler", source = "../backend/lambdas" }
    read-s3-context     = { handler = "tech_post.read_s3_context.handler", source = "../backend/lambdas" }
    generate-blog       = { handler = "blog_post.generate_blog.handler", source = "../backend/lambdas" }
    create-github-pr    = { handler = "blog_post.create_github_pr.handler", source = "../backend/lambdas" }
    workflow-trigger    = { handler = "api.workflow_trigger.handler", source = "../backend/lambdas" }
    approval-handler    = { handler = "api.approval_handler.handler", source = "../backend/lambdas" }
    data-handler        = { handler = "api.data_handler.handler", source = "../backend/lambdas" }
    schedule-handler    = { handler = "api.schedule_handler.handler", source = "../backend/lambdas" }
    # Payment follow-up workflow
    fetch-overdue-orders       = { handler = "payment_followup.fetch_overdue_orders.handler", source = "../backend/lambdas" }
    draft-payment-email        = { handler = "payment_followup.draft_payment_email.handler", source = "../backend/lambdas" }
    create-payment-approval    = { handler = "payment_followup.create_payment_approval.handler", source = "../backend/lambdas" }
    send-payment-email         = { handler = "payment_followup.send_payment_email.handler", source = "../backend/lambdas" }
  }
}

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "../backend/lambdas"
  output_path = "/tmp/lambda_package.zip"
}

resource "aws_lambda_function" "functions" {
  for_each = local.lambdas

  function_name    = "${local.prefix}-${each.key}"
  role             = aws_iam_role.lambda_exec.arn
  handler          = each.value.handler
  runtime          = "python3.11"
  timeout          = 300
  memory_size      = 512
  layers           = ["arn:aws:lambda:us-east-1:770693421928:layer:Klayers-p311-Pillow:11"]
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = merge(local.lambda_env, {
      SF_PREFIX = "${local.prefix}-"
    })
  }

  depends_on = [aws_iam_role_policy.lambda_policy]
}

resource "aws_cloudwatch_log_group" "lambda_logs" {
  for_each          = local.lambdas
  name              = "/aws/lambda/${local.prefix}-${each.key}"
  retention_in_days = 1
}

# ─────────────────────────────────────────────
# STEP FUNCTIONS
# ─────────────────────────────────────────────
locals {
  sf_substitutions = {
    GenerateLeadsArn    = aws_lambda_function.functions["generate-leads"].arn
    LoadLeadForEmailArn = aws_lambda_function.functions["load-lead-for-email"].arn
    CheckDuplicateArn   = aws_lambda_function.functions["check-duplicate"].arn
    SaveLeadArn         = aws_lambda_function.functions["save-lead"].arn
    DraftEmailArn       = aws_lambda_function.functions["draft-email"].arn
    CreateApprovalArn   = aws_lambda_function.functions["create-approval"].arn
    SendEmailArn        = aws_lambda_function.functions["send-email"].arn
    ScheduleFollowupArn = aws_lambda_function.functions["schedule-followup"].arn
    GetOrdersArn        = aws_lambda_function.functions["get-orders"].arn
    GeneratePostArn     = aws_lambda_function.functions["generate-post"].arn
    PostToPlatformsArn  = aws_lambda_function.functions["post-to-platforms"].arn
    ReadS3ContextArn    = aws_lambda_function.functions["read-s3-context"].arn
    GenerateBlogArn     = aws_lambda_function.functions["generate-blog"].arn
    CreateGitHubPRArn   = aws_lambda_function.functions["create-github-pr"].arn
    # Payment follow-up
    FetchOverdueOrdersArn    = aws_lambda_function.functions["fetch-overdue-orders"].arn
    DraftPaymentEmailArn     = aws_lambda_function.functions["draft-payment-email"].arn
    CreatePaymentApprovalArn = aws_lambda_function.functions["create-payment-approval"].arn
  }
}

resource "aws_sfn_state_machine" "lead_generation" {
  name       = "${local.prefix}-lead-generation"
  role_arn   = aws_iam_role.sfn_exec.arn
  definition = templatefile("${path.module}/../backend/step_functions/lead_generation.json", local.sf_substitutions)
}

resource "aws_sfn_state_machine" "lead_email_existing" {
  name       = "${local.prefix}-lead-email-existing"
  role_arn   = aws_iam_role.sfn_exec.arn
  definition = templatefile("${path.module}/../backend/step_functions/lead_email_existing.json", local.sf_substitutions)
}

resource "aws_sfn_state_machine" "social_product" {
  name       = "${local.prefix}-social-product"
  role_arn   = aws_iam_role.sfn_exec.arn
  definition = templatefile("${path.module}/../backend/step_functions/social_product.json", local.sf_substitutions)
}

resource "aws_sfn_state_machine" "social_tech" {
  name       = "${local.prefix}-social-tech"
  role_arn   = aws_iam_role.sfn_exec.arn
  definition = templatefile("${path.module}/../backend/step_functions/social_tech.json", local.sf_substitutions)
}

resource "aws_sfn_state_machine" "blog_post" {
  name       = "${local.prefix}-blog-post"
  role_arn   = aws_iam_role.sfn_exec.arn
  definition = templatefile("${path.module}/../backend/step_functions/blog_post.json", local.sf_substitutions)
}

resource "aws_sfn_state_machine" "payment_followup" {
  name       = "${local.prefix}-payment-followup"
  role_arn   = aws_iam_role.sfn_exec.arn
  definition = templatefile("${path.module}/../backend/step_functions/payment_followup.json", local.sf_substitutions)
}

# Update lambda envs with SF ARNs (circular dep resolved by targeting)
resource "aws_lambda_function_event_invoke_config" "workflow_trigger" {
  function_name = aws_lambda_function.functions["workflow-trigger"].function_name
}

# ─────────────────────────────────────────────
# API GATEWAY (HTTP API v2)
# ─────────────────────────────────────────────
resource "aws_apigatewayv2_api" "main" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["https://${var.workflow_domain}", "http://localhost:5173"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization", "X-Api-Key"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_logs.arn
    format = jsonencode({
      requestId               = "$context.requestId"
      ip                      = "$context.identity.sourceIp"
      requestTime             = "$context.requestTime"
      httpMethod              = "$context.httpMethod"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      protocol                = "$context.protocol"
      responseLength          = "$context.responseLength"
      integrationErrorMessage = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_cloudwatch_log_group" "api_logs" {
  name              = "/aws/apigateway/${local.prefix}"
  retention_in_days = 1
}

# Lambda integrations
resource "aws_apigatewayv2_integration" "workflow_trigger" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.functions["workflow-trigger"].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "approval_handler" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.functions["approval-handler"].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "data_handler" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.functions["data-handler"].invoke_arn
  payload_format_version = "2.0"
}

# Routes
resource "aws_apigatewayv2_route" "start_workflow" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /workflows/{type}"
  target    = "integrations/${aws_apigatewayv2_integration.workflow_trigger.id}"
}

resource "aws_apigatewayv2_route" "list_approvals" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /approvals"
  target    = "integrations/${aws_apigatewayv2_integration.approval_handler.id}"
}

resource "aws_apigatewayv2_route" "approve" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /approvals/{id}/approve"
  target    = "integrations/${aws_apigatewayv2_integration.approval_handler.id}"
}

resource "aws_apigatewayv2_route" "reject" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /approvals/{id}/reject"
  target    = "integrations/${aws_apigatewayv2_integration.approval_handler.id}"
}

resource "aws_apigatewayv2_route" "regenerate" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /approvals/{id}/regenerate"
  target    = "integrations/${aws_apigatewayv2_integration.approval_handler.id}"
}

resource "aws_apigatewayv2_route" "data" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /data/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.data_handler.id}"
}

resource "aws_apigatewayv2_route" "data_actions" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /data/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.data_handler.id}"
}

# Schedule handler integration
resource "aws_apigatewayv2_integration" "schedule_handler" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.functions["schedule-handler"].invoke_arn
  payload_format_version = "2.0"
}

# GET /schedules  — list all
resource "aws_apigatewayv2_route" "schedules_list" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /schedules"
  target    = "integrations/${aws_apigatewayv2_integration.schedule_handler.id}"
}

# POST /schedules  — create
resource "aws_apigatewayv2_route" "schedules_create" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /schedules"
  target    = "integrations/${aws_apigatewayv2_integration.schedule_handler.id}"
}

# GET /schedules/{id}  — get one
resource "aws_apigatewayv2_route" "schedules_get" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /schedules/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.schedule_handler.id}"
}

# PATCH /schedules/{id}  — update
resource "aws_apigatewayv2_route" "schedules_update" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "PATCH /schedules/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.schedule_handler.id}"
}

# DELETE /schedules/{id}  — delete
resource "aws_apigatewayv2_route" "schedules_delete" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "DELETE /schedules/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.schedule_handler.id}"
}

# PATCH /schedules/{id}/toggle  — enable/disable
resource "aws_apigatewayv2_route" "schedules_toggle" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "PATCH /schedules/{id}/toggle"
  target    = "integrations/${aws_apigatewayv2_integration.schedule_handler.id}"
}

# Lambda permissions for API Gateway
resource "aws_lambda_permission" "apigw_trigger" {
  for_each      = toset(["workflow-trigger", "approval-handler", "data-handler", "schedule-handler"])
  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.functions[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
