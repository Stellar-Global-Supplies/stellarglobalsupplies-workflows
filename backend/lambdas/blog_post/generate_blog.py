"""
Lambda: generate_blog
Generates a full blog post + featured image using Amazon Nova.
Image is non-blocking — blog saves without image if all options fail.
"""
import sys, os, uuid
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.bedrock_client  import generate_json, generate_text, generate_image
from shared.supabase_client import get_client
from shared.utils            import image_ext_and_type, slugify, upload_image_to_s3, upload_json_to_s3, now_iso

SYSTEM = """You are a professional content writer for Stellar Global Supplies, a global B2B supplier.
Write informative, SEO-optimized blog posts that provide genuine value to procurement professionals,
supply chain managers, and business owners. Use clear headings, practical advice, and professional tone."""


def _build_blog_image_prompt(title: str, topic: str, excerpt: str, tags: list) -> str:
    """Ask Nova to write a specific FLUX featured image prompt for the blog post."""
    tags_str  = ", ".join(tags[:5]) if tags else ""
    # Detect if topic is tech/software or physical product to pick the right style
    tech_keywords = {"software", "platform", "system", "workflow", "automation", "tech", "digital",
                     "dashboard", "api", "app", "saas", "cloud", "data", "analytics", "ai", "erp", "order management"}
    topic_lower = (topic + " " + title).lower()
    is_tech = any(kw in topic_lower for kw in tech_keywords)

    if is_tech:
        style_rules = """
- Describe a realistic editorial tech photograph: a laptop or monitor in a modern bright office
- Screen shows a relevant dashboard UI, workflow diagram, or analytics chart related to the blog topic
- Mention 2-3 specific UI elements visible on screen that relate to the blog topic
- Natural window light, wooden desk, shallow depth of field, sharp screen
- Navy and gold colour accents on the UI visible on screen
- Style: realistic DSLR editorial tech photography
- Never use: physical products, industrial setting, warehouse, machinery"""
    else:
        style_rules = """
- Describe a realistic product or industry photograph relevant to the blog topic
- Simple clean background: grey studio sweep, wooden workbench, or professional office
- If physical products: natural even lighting, sharp product, slight background blur
- If people/business: professional office setting, natural light, candid feel
- Muted natural tones, no HDR or oversaturation
- Style: realistic DSLR editorial photography
- Never use: cinematic, render, 3D, glowing, AI art style"""

    instruction = f"""Write a FLUX image generation prompt (60-80 words) for a featured blog post image.

Blog title: {title}
Topic: {topic}
Summary: {excerpt[:200]}
Tags: {tags_str}

Style rules:{style_rules}

Additional rules:
- Be specific — describe exact visual elements, not generic descriptions
- Include: "DSLR photo", "natural lighting", "realistic", "photorealistic"
- Output ONLY the prompt — no explanation, no preamble, no quotes"""

    try:
        prompt = generate_text(instruction, max_tokens=150).strip().strip('"')
        print(f"[generate_blog] image prompt: {prompt[:100]}")
        return prompt
    except Exception as e:
        print(f"[generate_blog] image prompt generation failed ({e}) — using fallback")
        if is_tech:
            return f"Realistic DSLR photo of a laptop in a modern professional office showing a clean dashboard UI related to {topic}, natural window light, sharp screen, shallow depth of field, realistic tech photography"
        else:
            return f"Realistic DSLR editorial photo representing {topic} for a B2B industrial supply company, natural lighting, professional setting, photorealistic"


def handler(event, context):
    topic         = event.get("topic", "")
    keywords      = event.get("keywords", [])
    word_count    = event.get("word_count", 800)
    custom_prompt = event.get("custom_prompt", "")

    # ── Generate blog content ─────────────────────────────────
    print(f"[generate_blog] generating blog content for topic={topic!r}")
    prompt = f"""
Write a comprehensive blog post for Stellar Global Supplies website.

Topic: {topic or "Best practices in B2B procurement and supply chain management"}
Target keywords: {", ".join(keywords) if keywords else "supply chain, B2B procurement, industrial supplies"}
Target word count: {word_count} words
{f"Additional instructions: {custom_prompt}" if custom_prompt else ""}

Return valid JSON with these exact keys:
{{
  "title": "SEO-optimized blog post title",
  "excerpt": "2-3 sentence summary for meta description (under 160 chars)",
  "content": "full markdown blog post content with ## headings, practical examples, conclusion",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}}"""

    blog_data = generate_json(prompt, system=SYSTEM, max_tokens=3000)
    print(f"[generate_blog] blog content generated, title={blog_data.get('title','')!r}")

    title   = blog_data.get("title", topic)
    excerpt = blog_data.get("excerpt", "")
    tags    = blog_data.get("tags", [])

    # ── Build image prompt separately (dedicated call, full context) ──────────
    img_prompt = _build_blog_image_prompt(
        title=title,
        topic=topic,
        excerpt=excerpt,
        tags=tags,
    )

    content_key = f"generated-content/blog-posts/{uuid.uuid4()}.json"
    content_url = upload_json_to_s3({
        "title":        title,
        "excerpt":      excerpt,
        "content":      blog_data.get("content", ""),
        "tags":         tags,
        "image_prompt": img_prompt,
        "topic":        topic,
        "keywords":     keywords,
    }, content_key)

    # ── Generate image (non-blocking) ─────────────────────────
    image_url = None
    img_key   = None
    print(f"[generate_blog] generating featured image")
    try:
        image_bytes = generate_image(img_prompt, width=1200, height=630)  # OG image ratio
        if image_bytes:
            ext, content_type = image_ext_and_type(image_bytes)
            img_key   = f"blog-images/{uuid.uuid4()}{ext}"
            image_url = upload_image_to_s3(image_bytes, img_key, content_type=content_type)
            print(f"[generate_blog] image uploaded: {img_key}")
        else:
            print("[generate_blog] generate_image returned None — saving without image")
    except Exception as e:
        print(f"[generate_blog] image step failed ({e}) — saving without image")

    slug = slugify(title) + f"-{uuid.uuid4().hex[:6]}"

    # ── Save draft to Supabase ────────────────────────────────
    db  = get_client()
    row = {
        "title":           title,
        "slug":            slug,
        "excerpt":         excerpt,
        "content":         blog_data.get("content", "")[:500],
        "content_s3_key":  content_key,
        "content_url":     content_url,
        "image_url":       image_url,
        "image_s3_key":    img_key,
        "tags":            tags,
        "status":          "draft",
        "workflow_run_id": event.get("workflowRunId") or None,
    }
    row = {k: v for k, v in row.items() if v is not None}

    optional_columns = ["content_s3_key", "content_url", "workflow_run_id"]
    insert_row = row.copy()
    while True:
        try:
            saved = db.insert("blog_posts", insert_row)
            break
        except Exception as exc:
            missing = next((col for col in optional_columns if col in str(exc) and col in insert_row), None)
            if not missing:
                raise
            insert_row = {k: v for k, v in insert_row.items() if k != missing}

    print(f"[generate_blog] DONE blogId={saved['id']}")
    return {
        **event,
        "blogId": saved["id"],
        "blog": {
            **saved,
            "content":        blog_data.get("content", "")[:500],
            "content_s3_key": content_key,
            "content_url":    content_url,
            "image_url":      image_url,
            "hasImage":       image_url is not None,
        },
    }