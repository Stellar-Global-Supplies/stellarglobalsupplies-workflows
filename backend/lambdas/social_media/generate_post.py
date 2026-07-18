"""
Lambda: generate_social_post
Generates social media content + image for a product or tech post.
Image is non-blocking — post saves without image if all options fail.

Schema reference (social_posts — live production):
  NOT NULL required: social_workflow_id, platform, caption, raw_caption,
                     hashtags, status, orders_included, week_start
  status allowed:    pending_approval | approved_manual | publishing |
                     published | rejected | publish_failed
  platform allowed:  linkedin | facebook | instagram
  Nullable extras:   type, title, content, image_url, image_s3_key,
                     platforms, order_id, repo_name, prompt, post_results,
                     posted_at, workflow_run_id, content_s3_key, content_url
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

    # social_workflow_id: optional traceability field — FK and NOT NULL dropped via migration
    social_workflow_id = (
        event.get("socialWorkflowId")
        or event.get("social_workflow_id")
        or event.get("workflowRunId")
        or event.get("workflow_run_id")
        or None
    )

    print(f"[generate_post] START post_type={post_type!r} repo_name={repo_name!r} order_id={order_id!r} social_workflow_id={social_workflow_id!r}")

    # ── Dedup by order id ─────────────────────────────────────
    if post_type == "product" and order_id:
        db  = get_client()
        order_id_filter = urllib.parse.quote(str(order_id), safe="")
        rows = db.select(
            "social_posts",
            params=f"order_id=eq.{order_id_filter}&type=eq.product&limit=1",
        )
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
  "hashtags": ["tag1", "tag2", "tag3"],
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
  "hashtags": ["tag1", "tag2", "tag3"],
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
        "hashtags": content_data.get("hashtags", []),
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

    # ── Build insert row aligned to live schema ───────────────
    print(f"[generate_post] saving post to Supabase")
    db = get_client()

    # week_start: Monday of the current UTC week (NOT NULL)
    today = datetime.now(timezone.utc).date()
    week_start = (today - timedelta(days=today.weekday())).isoformat()

    # caption: NOT NULL — fall back through platform-specific → title
    # Primary platform is linkedin for tech (B2B), facebook for product
    primary_platform = "linkedin" if post_type == "tech" else "facebook"
    caption = (
        content_data.get(primary_platform)
        or content_data.get("instagram")
        or content_data.get("facebook")
        or content_data.get("title")
        or ""
    )

    # hashtags: NOT NULL array — parse from AI response or default empty
    raw_hashtags = content_data.get("hashtags", [])
    if isinstance(raw_hashtags, str):
        # AI sometimes returns a space-separated string
        raw_hashtags = [h.lstrip("#") for h in raw_hashtags.split() if h]
    hashtags = [str(h).lstrip("#") for h in raw_hashtags if h] if raw_hashtags else []

    # NOT NULL columns (must always be present)
    row = {
        "social_workflow_id": social_workflow_id,
        "platform":           primary_platform,
        "caption":            caption,
        "raw_caption":        caption,
        "hashtags":           hashtags,
        "status":             "pending_approval",
        "orders_included":    [],
        "week_start":         week_start,
    }

    # Nullable / optional columns (omit if no value)
    optional = {
        "type":           post_type,
        "title":          content_data.get("title") or None,
        "content":        (content_data.get("facebook") or "")[:500] or None,
        "image_url":      image_url,
        "image_s3_key":   img_key,
        "image_prompt":   img_prompt or None,
        "platforms":      {"facebook": True, "instagram": True, "linkedin": True},
        "order_id":       order_id if post_type == "product" and order_id else None,
        "repo_name":      repo_name if post_type == "tech" and repo_name else None,
        "prompt":         prompt or None,
        "workflow_run_id": event.get("workflowRunId") or event.get("workflow_run_id") or None,
        "content_s3_key": content_key,
        "content_url":    content_url,
    }
    for k, v in optional.items():
        if v is not None:
            row[k] = v

    print(f"[generate_post] inserting row keys={list(row.keys())}")
    saved = db.insert("social_posts", row)

    print(f"[generate_post] DONE postId={saved['id']}")
    return {
        **event,
        "isDuplicate": False,
        "postId":      saved["id"],
        "post":        {
            **saved,
            "title":         content_data.get("title", ""),
            "content":       (content_data.get("facebook") or "")[:500],
            "content_s3_key": content_key,
            "content_url":   content_url,
            "image_url":     image_url,
            "hasImage":      image_url is not None,
        },
    }