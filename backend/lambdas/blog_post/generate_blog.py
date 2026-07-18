"""
Lambda: generate_blog
Generates a full blog post with title, content, and image using Amazon Nova.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import uuid
from shared.bedrock_client import generate_json, generate_image
from shared.supabase_client import get_client
from shared.utils import slugify, upload_image_to_s3, now_iso

SYSTEM = """You are a professional content writer for Stellar Global Supplies, a global B2B supplier.
Write informative, SEO-optimized blog posts that provide genuine value to procurement professionals,
supply chain managers, and business owners. Use clear headings, practical advice, and professional tone."""


def handler(event, context):
    topic        = event.get("topic", "")
    keywords     = event.get("keywords", [])
    word_count   = event.get("word_count", 800)
    custom_prompt = event.get("custom_prompt", "")

    # Generate blog content
    prompt = f"""
Write a comprehensive blog post for Stellar Global Supplies website.

Topic: {topic or "Best practices in B2B procurement and supply chain management"}
Target keywords: {", ".join(keywords) if keywords else "supply chain, B2B procurement, industrial supplies"}
Target word count: {word_count} words
{f"Additional instructions: {custom_prompt}" if custom_prompt else ""}

Return valid JSON:
{{
  "title": "SEO-optimized blog post title",
  "excerpt": "2-3 sentence summary for meta description (under 160 chars)",
  "content": "full markdown blog post content with ## headings, bullet points, conclusion",
  "tags": ["tag1", "tag2", "tag3"],
  "image_prompt": "detailed prompt to generate a professional featured image for this blog post"
}}
"""
    blog_data = generate_json(prompt, system=SYSTEM, max_tokens=3000)

    # Generate featured image
    img_prompt  = blog_data.get("image_prompt", f"Professional blog image about {topic} for B2B supply company")
    image_bytes = generate_image(img_prompt, width=1200, height=630)
    img_key     = f"blog-images/{uuid.uuid4()}.png"
    image_url   = upload_image_to_s3(image_bytes, img_key)

    title = blog_data.get("title", topic)
    slug  = slugify(title) + f"-{uuid.uuid4().hex[:6]}"

    # Save draft to Supabase
    db  = get_client()
    row = {
        "title":           title,
        "slug":            slug,
        "excerpt":         blog_data.get("excerpt", ""),
        "content":         blog_data.get("content", ""),
        "image_url":       image_url,
        "image_s3_key":    img_key,
        "tags":            blog_data.get("tags", []),
        "status":          "draft",
        "workflow_run_id": event.get("workflowRunId"),
    }
    saved = db.insert("blog_posts", row)

    return {
        **event,
        "blogId":  saved["id"],
        "blog":    {**saved, "image_url": image_url},
    }
