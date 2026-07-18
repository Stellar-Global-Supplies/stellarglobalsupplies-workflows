"""
Lambda: generate_social_post
Generates social media content + image for a product or tech post.
Image is non-blocking — post saves without image if all options fail.
"""
import sys, os, uuid, urllib.parse
from datetime import datetime, timezone, timedelta
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
    context_text = event.get("contextText", "")

    print(f"[generate_post] START post_type={post_type!r} repo_name={repo_name!r} order_id={order_id!r}")

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
                print(f"[generate_post] duplicate found — skipping")
                return {**event, "isDuplicate": True, "existingPostId": rows[0]["id"]}

    # ── Generate text content ─────────────────────────────────
    print(f"[generate_post] calling Bedrock to generate {post_type} post content")
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
        context_section = f"\n\nPlatform context:\n{context_text}" if context_text else ""
        gen_prompt = f"""
Create an engaging tech/showcase social media post for Stellar Global Supplies about our platform.
{"Custom prompt: " + prompt if prompt else "Highlight our workflow automation capabilities."}
Repo: {repo_name}{context_section}

Return JSON:
{{
  "title": "short post title",
  "facebook": "facebook post text",
  "instagram": "instagram caption",
  "linkedin": "linkedin post (professional)",
  "image_prompt": "prompt for a modern tech/digital workflow image"
}}"""

    content_data = generate_json(gen_prompt, system=SYSTEM, max_tokens=1200)
    print(f"[generate_post] Bedrock text generation complete, title={content_data.get('title','')!r}")
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

    print(f"[generate_post] starting image generation (non-blocking)")
    try:
        image_bytes = generate_image(img_prompt)
        if image_bytes:
            ext, content_type = image_ext_and_type(image_bytes)
            img_key = f"social-posts/{post_type}/{uuid.uuid4()}{ext}"
            image_url = upload_image_to_s3(image_bytes, img_key, content_type=content_type)
            print(f"[generate_post] image uploaded: {img_key}")
        else:
            print("[generate_post] generate_image returned None — saving without image")
    except Exception as e:
        print(f"[generate_post] image step failed ({e}) — saving without image")

    # ── Save to Supabase ──────────────────────────────────────
    print(f"[generate_post] saving post to Supabase")
    db  = get_client()
    workflow_run_id = event.get("workflowRunId")

    # week_start: Monday of the current UTC week (required NOT NULL column)
    today = datetime.now(timezone.utc).date()
    week_start = (today - timedelta(days=today.weekday())).isoformat()

    # caption must never be None/empty — fall back through instagram → facebook → title
    caption = (
        content_data.get("instagram")
        or content_data.get("facebook")
        or content_data.get("title")
        or ""
    )

    # order_uuid must be a real UUID string or omitted — never the string "None"
    safe_order_uuid = order_uuid if (order_uuid and order_uuid != "None") else None

    row = {
        "type":              post_type,
        "title":             content_data.get("title", ""),
        "content":           content_data.get("facebook", "")[:500],
        "caption":           caption,
        "week_start":        week_start,
        "content_s3_key":    content_key,
        "content_url":       content_url,
        "image_url":         image_url,
        "image_s3_key":      img_key,
        # "platform" TEXT column has a check constraint limiting values to
        # 'facebook' | 'instagram' | 'linkedin' — 'multi' is not allowed.
        # Use the primary/lead platform: linkedin for tech posts (B2B), facebook for product posts.
        "platform":          "linkedin" if post_type == "tech" else "facebook",
        "platforms":         {"facebook": True, "instagram": True, "linkedin": True},
        "status":            "draft",
        "order_id":          order_id if post_type == "product" else None,
        "order_uuid":        safe_order_uuid if post_type == "product" else None,
        "repo_name":         repo_name if post_type == "tech" else None,
        "prompt":            prompt,
        "workflow_run_id":   workflow_run_id,
        "social_workflow_id": workflow_run_id,
    }
    row = {k: v for k, v in row.items() if v is not None}
    # optional_columns: stripped one-by-one if the DB column does not exist yet.
    # required_columns: MUST NOT overlap with optional_columns — any column in both
    #   lists causes an infinite loop (removed then immediately re-added each iteration).
    # "platform" (TEXT label) is required (NOT NULL in DB); "platforms" (JSONB map) is also required.
    # "caption" and "week_start" are also optional (added by migration 005).
    optional_columns = ["content_s3_key", "content_url", "order_uuid", "workflow_run_id", "social_workflow_id",
                        "caption", "week_start", "image_url", "image_s3_key", "repo_name", "order_id"]
    required_columns = ["platform", "platforms", "type", "content", "status"]
    print(f"[generate_post] Insert row to Supabase")
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
            # Ensure required columns are never removed
            for req_col in required_columns:
                if req_col in row and req_col not in insert_row:
                    insert_row[req_col] = row[req_col]

    print(f"[generate_post] DONE postId={saved['id']}")
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