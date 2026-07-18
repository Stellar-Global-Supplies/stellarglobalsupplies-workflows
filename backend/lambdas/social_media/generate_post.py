"""
Lambda: generate_social_post
Generates social media content + image for a product or tech post.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import hashlib
import uuid
from shared.bedrock_client import generate_json, generate_image
from shared.supabase_client import get_client
from shared.utils import upload_image_to_s3, now_iso, content_hash

SYSTEM = """You are a social media manager for Stellar Global Supplies.
Write engaging, professional posts that showcase our products and services.
Include relevant hashtags. Keep Facebook/LinkedIn posts under 300 chars, Instagram under 200."""


def handler(event, context):
    post_type = event.get("type", "product")  # "product" or "tech"
    prompt    = event.get("prompt", "")
    order     = event.get("order", {})
    repo_name = event.get("repo_name", "")

    # Check for duplicate by order_id (product posts only)
    if post_type == "product":
        order_id = event.get("orderId", "")
        if order_id:
            db   = get_client()
            rows = db.select("social_posts",
                             params=f"order_id=eq.{order_id}&type=eq.product&limit=1")
            if rows:
                return {
                    **event,
                    "isDuplicate": True,
                    "existingPostId": rows[0]["id"],
                }

    # Build content generation prompt
    if post_type == "product":
        gen_prompt = f"""
Create engaging social media posts for Stellar Global Supplies about this product:
- Product: {order.get('product_name', '')}
- Category: {order.get('product_category', '')}
- Description: {order.get('description', '')}
- Customer Segment: {order.get('customer_segment', '')}
{"Custom prompt: " + prompt if prompt else ""}

Generate platform-specific content. Return JSON:
{{
  "title": "short post title",
  "facebook": "facebook post text with hashtags",
  "instagram": "instagram caption with hashtags",
  "linkedin":  "linkedin post (professional tone)",
  "image_prompt": "detailed prompt for generating a product showcase image"
}}
"""
    else:
        gen_prompt = f"""
Create an engaging tech/showcase social media post for Stellar Global Supplies about our platform.
{"Custom prompt: " + prompt if prompt else "Highlight our workflow automation capabilities."}
Repo/context: {repo_name}

Return JSON:
{{
  "title": "short post title",
  "facebook": "facebook post text",
  "instagram": "instagram caption",
  "linkedin": "linkedin post (professional)",
  "image_prompt": "prompt for a tech/modern image showing digital workflow or supply chain"
}}
"""

    content_data = generate_json(gen_prompt, system=SYSTEM, max_tokens=1200)

    # Generate image
    img_prompt  = content_data.get("image_prompt", f"Professional {post_type} image for Stellar Global Supplies")
    image_bytes = generate_image(img_prompt)
    img_key     = f"social-posts/{post_type}/{uuid.uuid4()}.png"
    image_url   = upload_image_to_s3(image_bytes, img_key)

    combined_content = content_data.get("facebook", "")

    # Save to Supabase
    db  = get_client()
    row = {
        "type":          post_type,
        "title":         content_data.get("title", ""),
        "content":       combined_content,
        "image_url":     image_url,
        "image_s3_key":  img_key,
        "platforms":     {"facebook": True, "instagram": True, "linkedin": True},
        "status":        "draft",
        "order_id":      event.get("orderId") if post_type == "product" else None,
        "repo_name":     repo_name if post_type == "tech" else None,
        "prompt":        prompt,
        "workflow_run_id": event.get("workflowRunId"),
    }
    saved = db.insert("social_posts", row)

    return {
        **event,
        "isDuplicate": False,
        "postId":      saved["id"],
        "post":        {**saved, **content_data, "image_url": image_url},
    }
