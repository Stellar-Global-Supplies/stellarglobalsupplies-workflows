"""
Lambda: generate_social_post
Generates social media content + image for a product or tech post.
Image is non-blocking — post saves without image if all options fail.
"""
import sys, os, uuid, urllib.parse
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.bedrock_client  import generate_json, generate_image
from shared.supabase_client import get_client
from shared.utils            import image_ext_and_type, upload_image_to_s3, upload_json_to_s3, now_iso, content_hash

SYSTEM = """You are a social media manager for Stellar Global Supplies.
Write engaging, professional posts that showcase our products and services.
Include relevant hashtags. Keep Facebook/LinkedIn posts under 300 chars, Instagram under 200."""


def handler(event, context):
    post_type = event.get("type", "product")
    prompt    = event.get("prompt", "")
    order     = event.get("order", {})
    repo_name = event.get("repo_name", "")
    order_id  = event.get("orderKey") or event.get("orderId") or event.get("order_id") or ""
    order_uuid = event.get("orderUuid") or ""

    # ── Dedup by order id / uuid ───────────────────────────────
    if post_type == "product":
        if order_uuid or order_id:
            db   = get_client()
            rows = []
            if order_id:
                order_id_filter = urllib.parse.quote(str(order_id), safe="")
                rows = db.select(
                    "social_posts",
                    params=f"order_id=eq.{order_id_filter}&type=eq.product&limit=1",
                )
            if not rows and order_uuid:
                order_uuid_filter = urllib.parse.quote(str(order_uuid), safe="")
                try:
                    rows = db.select(
                        "social_posts",
                        params=f"order_uuid=eq.{order_uuid_filter}&type=eq.product&limit=1",
                    )
                except Exception as exc:
                    if "order_uuid" not in str(exc):
                        raise
            if rows:
                return {**event, "isDuplicate": True, "existingPostId": rows[0]["id"]}

    # ── Generate text content ─────────────────────────────────
    if post_type == "product":
        gen_prompt = f"""
Create engaging social media posts for Stellar Global Supplies about this product:
- Product: {order.get('product_name', '')}
- Category: {order.get('product_category', '')}
- Description: {order.get('description', '')}
- Customer Segment: {order.get('customer_segment', '')}
{"Custom prompt: " + prompt if prompt else ""}

Return JSON:
{{
  "title": "short post title",
  "facebook": "facebook post text with hashtags",
  "instagram": "instagram caption with hashtags",
  "linkedin":  "linkedin post (professional tone)",
  "image_prompt": "detailed prompt for generating a product showcase image"
}}"""
    else:
        gen_prompt = f"""
Create an engaging tech/showcase social media post for Stellar Global Supplies about our platform.
{"Custom prompt: " + prompt if prompt else "Highlight our workflow automation capabilities."}
Repo: {repo_name}

Return JSON:
{{
  "title": "short post title",
  "facebook": "facebook post text",
  "instagram": "instagram caption",
  "linkedin": "linkedin post (professional)",
  "image_prompt": "prompt for a modern tech/digital workflow image"
}}"""

    content_data = generate_json(gen_prompt, system=SYSTEM, max_tokens=1200)
    content_key = f"generated-content/social-posts/{post_type}/{uuid.uuid4()}.json"
    content_url = upload_json_to_s3({
        "type": post_type,
        "title": content_data.get("title", ""),
        "facebook": content_data.get("facebook", ""),
        "instagram": content_data.get("instagram", ""),
        "linkedin": content_data.get("linkedin", ""),
        "image_prompt": content_data.get("image_prompt", ""),
        "prompt": prompt,
        "repo_name": repo_name,
        "order": order,
    }, content_key)

    # ── Generate image (non-blocking) ─────────────────────────
    img_prompt = content_data.get("image_prompt",
                                  f"Professional {post_type} image for Stellar Global Supplies")
    image_url = None
    img_key   = None

    try:
        image_bytes = generate_image(img_prompt)
        if image_bytes:
            ext, content_type = image_ext_and_type(image_bytes)
            img_key = f"social-posts/{post_type}/{uuid.uuid4()}{ext}"
            image_url = upload_image_to_s3(image_bytes, img_key, content_type=content_type)
        else:
            print("[generate_post] generate_image returned None — saving without image")
    except Exception as e:
        print(f"[generate_post] image step failed ({e}) — saving without image")

    # ── Save to Supabase ──────────────────────────────────────
    db  = get_client()
    workflow_run_id = event.get("workflowRunId")
    row = {
        "type":            post_type,
        "title":           content_data.get("title", ""),
        "content":         content_data.get("facebook", "")[:500],
        "content_s3_key":  content_key,
        "content_url":     content_url,
        "image_url":       image_url,
        "image_s3_key":    img_key,
        "platforms":       {"facebook": True, "instagram": True, "linkedin": True},
        "status":          "draft",
        "order_id":        order_id if post_type == "product" else None,
        "order_uuid":      order_uuid or None if post_type == "product" else None,
        "repo_name":       repo_name if post_type == "tech" else None,
        "prompt":          prompt,
        "workflow_run_id": workflow_run_id,
        "social_workflow_id": workflow_run_id,
    }
    row = {k: v for k, v in row.items() if v is not None}
    optional_columns = ["content_s3_key", "content_url", "order_uuid", "workflow_run_id", "social_workflow_id"]
    insert_row = row.copy()
    while True:
        try:
            saved = db.insert("social_posts", insert_row)
            break
        except Exception as exc:
            missing = next((col for col in optional_columns if col in str(exc) and col in insert_row), None)
            if not missing:
                raise
            insert_row = {k: v for k, v in insert_row.items() if k != missing}

    return {
        **event,
        "isDuplicate": False,
        "postId":      saved["id"],
        "post":        {
            **saved,
            "title": content_data.get("title", ""),
            "content": content_data.get("facebook", "")[:500],
            "content_s3_key": content_key,
            "content_url": content_url,
            "image_url": image_url,
            "hasImage": image_url is not None,
        },
    }
