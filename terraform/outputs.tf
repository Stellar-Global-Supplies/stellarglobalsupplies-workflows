output "cloudfront_domain" {
  description = "CloudFront distribution domain"
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (needed for cache invalidation)"
  value       = aws_cloudfront_distribution.frontend.id
}

output "frontend_bucket" {
  description = "S3 bucket name for frontend deployment"
  value       = aws_s3_bucket.frontend.bucket
}

output "assets_bucket" {
  description = "S3 bucket for AI-generated assets"
  value       = aws_s3_bucket.assets.bucket
}

output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "workflow_url" {
  description = "Workflow platform URL"
  value       = "https://${var.workflow_domain}"
}

output "state_machines" {
  description = "Step Functions state machine ARNs"
  value = {
    lead_generation = aws_sfn_state_machine.lead_generation.arn
    social_product  = aws_sfn_state_machine.social_product.arn
    social_tech     = aws_sfn_state_machine.social_tech.arn
    blog_post       = aws_sfn_state_machine.blog_post.arn
  }
}
