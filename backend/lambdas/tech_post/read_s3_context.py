"""
Lambda: read_s3_context
Reads reponame/ai_context.md from S3 to generate a tech showcase post.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import boto3


def handler(event, context):
    repo_name  = event.get("repo_name", "")
    bucket     = os.environ.get("CONTEXT_BUCKET", os.environ.get("ASSETS_BUCKET"))
    s3_key     = f"{repo_name}/ai_context.md" if repo_name else "ai_context.md"

    s3 = boto3.client("s3")
    try:
        resp    = s3.get_object(Bucket=bucket, Key=s3_key)
        context_text = resp["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        # Fallback: use generic company context
        context_text = """
# Stellar Global Supplies - Platform Overview

## Workflows Platform
An intelligent workflow automation system that helps our team:
- Generate and manage B2B leads with AI assistance
- Create and schedule social media content
- Automate email outreach with approval workflows
- Generate blog content and create GitHub PRs automatically

## Tech Stack
- Frontend: React + Vite on AWS S3/CloudFront
- Backend: AWS Step Functions + Python Lambda
- AI: Amazon Nova (Bedrock) for text and image generation
- Database: Supabase (PostgreSQL)
- Auth: Supabase Auth

## Key Features
- Human-in-the-loop approvals at every step
- Duplicate prevention for leads and posts
- Multi-platform social media posting (Facebook, Instagram, LinkedIn)
- Automated GitHub PR creation for blog posts
"""

    return {
        **event,
        "contextText":  context_text,
        "repo_name":    repo_name,
        "s3_key":       s3_key,
        "type":         "tech",
    }
