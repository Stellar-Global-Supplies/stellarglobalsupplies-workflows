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

from shared.bedrock_client  import generate_json, generate_text, generate_image, reset_cost_tracker, get_cost_summary
from shared.supabase_client import get_client
from shared.utils            import image_ext_and_type, upload_image_to_s3, upload_json_to_s3, now_iso, content_hash

# ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
# Two distinct writing modes — product advertising and tech credibility building.
# Both always serve one goal: get procurement managers and business owners to
# contact Stellar Global Supplies for their supply needs.

SYSTEM = """You are a senior B2B marketing copywriter for Stellar Global Supplies — a trusted B2B industrial and commercial supplies company based in Pune, India. We supply Stainless Steel (SS), Mild Steel (MS), Fasteners (bolts, nuts, washers, circlips, anchor fasteners), Pipes, Fittings, and Commercial/Hospitality supplies to manufacturers, contractors, plant managers, hospitality businesses, and procurement teams across India and globally.

Our strengths: ISI/BIS certified products, strict quality checks, competitive bulk pricing, pan-India delivery, 500+ SKUs, dedicated B2B account management, and now a fully digital order management system.

Your writing goal is always the same regardless of post type: make the reader want to contact Stellar Global Supplies for their supply requirements.

═══ PRODUCT POST MODE ═══

Write like a confident sales advertisement — not a product description. Create desire, show value, drive action.

LinkedIn structure (1500-2000 chars minimum, EXACT format):

LINE 1: A powerful hook. State the buyer's pain point, a striking fact about the product category, or a bold business claim. Make a procurement manager stop scrolling. No fluff.

[blank line]

PARAGRAPH 1 — THE PROBLEM (3-4 sentences): Paint the real business cost of getting this product wrong — substandard quality, supply delays, wrong specs, vendor unreliability. Be specific to the industries that use this product (manufacturing plants, construction sites, hospitality, logistics). Make the reader feel the problem.

[blank line]

PARAGRAPH 2 — OUR PRODUCT (3-4 sentences): Introduce the specific product with confidence. Mention grades, standards (ISI/BIS/IS:1367 etc), sizes, and why quality matters for this specific application. Write like an expert who knows exactly what a plant manager needs to hear.

[blank line]

PARAGRAPH 3 — WHO BUYS THIS AND WHY (3-4 sentences): Name specific industries and use cases. Mention measurable benefits: reduced downtime, lower rejection rates, consistent supply, bulk availability. Make the reader see themselves in this.

[blank line]

PARAGRAPH 4 — WHY STELLAR (2-3 sentences): Our specific differentiators for this product — not generic claims. Mention certifications, quality control process, bulk pricing advantage, delivery reliability, or account management. Confidence, not modesty.

[blank line]

CTA: One sharp, specific line. "DM us for bulk pricing on [product]." OR "Comment your requirement — our team responds in 2 hours." OR "Visit stellarglobalsupplies.com or call us for a same-day quote." Pick what fits.

[blank line]

HASHTAGS: 8-10 hashtags. Mix: product category + industry + B2B/procurement + India + Stellar brand. Examples: #StainlessSteel #Fasteners #B2BIndia #IndustrialSupply #Procurement #MakeInIndia #StellarGlobalSupplies

Rules: No em-dashes. No bullet points. Plain paragraphs. Confident, direct, expert tone — like a senior sales director writing to Indian business decision-makers.

═══ TECH POST MODE ═══

Write to prove Stellar is a modern, reliable B2B supply partner — not to show off technology. The technology is evidence of our operational excellence, not the product itself.

The reader should finish the post thinking: "These guys have their act together. I should talk to them about my supply requirements." — NOT "cool platform, I wonder what it does."

LinkedIn structure (1500-2000 chars minimum, EXACT format):

LINE 1: A hook about a business outcome the buyer cares about — faster delivery, live order tracking, zero supply disruption, accurate bulk ordering. Frame it as something WE deliver TO THEM through our technology.

[blank line]

PARAGRAPH 1 — THE BUYER'S PROBLEM (3-4 sentences): Describe the real frustration of B2B procurement — chasing suppliers for order status, dealing with delays, no visibility into delivery timelines, manual PO processes. Write from the buyer's perspective. This is the pain our platform solves for them.

[blank line]

PARAGRAPH 2 — WHAT WE BUILT AND HOW IT HELPS THEM (3-4 sentences): Explain the specific technology feature in plain language from the buyer's benefit perspective. "Our order management system gives you real-time tracking on every SS and MS order from confirmation to delivery." Connect every tech feature to a supply outcome. Never mention the tech in isolation.

[blank line]

PARAGRAPH 3 — WHAT THIS MEANS FOR YOUR BUSINESS (3-4 sentences): Concrete business outcomes for the buyer — procurement teams saving hours per week, plant managers never running out of critical fasteners, hospitality buyers getting accurate delivery ETAs. Name specific product categories (SS pipes, anchor fasteners, MS plates) to make it real.

[blank line]

PARAGRAPH 4 — STELLAR AS YOUR SUPPLY PARTNER (2-3 sentences): Bridge firmly to the core business. "This is how we supply [SS/MS/Fasteners/Commercial goods] to [industries] across India. Our technology is just how we make sure your orders are handled the way they deserve to be." Always land on the supply business.

[blank line]

CTA: Drive supply enquiries, not tech interest. "If you need reliable, trackable B2B supplies — SS, MS, Fasteners, or Commercial goods — DM us or visit stellarglobalsupplies.com." Never ask people to "check out our platform."

[blank line]

HASHTAGS: Mix of BOTH tech AND supply/industry tags. Examples: #B2BSupplyChain #OrderManagement #StainlessSteel #Fasteners #IndustrialSupply #Procurement #TechInSupplyChain #MadeInIndia #StellarGlobalSupplies #B2BIndia

Rules: No em-dashes. No bullet points. Plain paragraphs. Write as a supply company that happens to have great technology — not a tech company that sells supplies.
"""

# ─── COMPANY CONTEXT (injected into all prompts) ─────────────────────────────
COMPANY_CONTEXT = """
Stellar Global Supplies — key facts to weave into content naturally:
- Based in Pune, India
- Core products: Stainless Steel (SS 304, 316, 202), Mild Steel (MS), Fasteners (bolts, nuts, washers, circlips, anchor fasteners, threaded rods), Pipes & Fittings, Commercial/Hospitality supplies
- Certifications: ISI/BIS certified, IS:1367 compliant fasteners
- Customers: manufacturers, plant managers, contractors, construction companies, hospitality/hotel chains, procurement teams
- Strengths: 500+ SKUs, pan-India delivery, bulk pricing, 2-hour response time, dedicated B2B account management
- Digital: fully automated order management system with real-time tracking
- Website: stellarglobalsupplies.com
"""

# ─── IMAGE PROMPT BUILDERS ────────────────────────────────────────────────────

def _build_product_image_prompt(product_name: str, category: str, description: str, customer_segment: str) -> str:
    """
    Build a marketing-style product image prompt — not just a product photo,
    but a scene that sells: product in use, in a real industry environment,
    with implied quality and reliability.
    """
    instruction = f"""Write a FLUX image generation prompt (70-90 words) for a B2B marketing photograph that SELLS this product.

Product: {product_name}
Category: {category}
Description: {description}
Customer segment: {customer_segment}

This is NOT a plain product catalogue photo. It should feel like a professional marketing image that shows the product being used or ready for use in a real industrial or commercial setting.

Rules:
- Show the product in context — on a factory floor, construction site, industrial shelf, or professional workshop — whichever fits the product
- Include environmental details that imply quality and reliability: clean organised workspace, proper safety equipment visible, professional setting
- Natural industrial lighting — not studio lighting
- The product should be sharp and prominent, background slightly blurred
- Muted professional colour tones — no oversaturation
- Style: realistic commercial photography, DSLR, editorial feel
- Include: "commercial photography", "DSLR", "natural lighting", "photorealistic", "sharp focus"
- If the product is SS/stainless steel — show its shine naturally without being overdramatic
- If fasteners/bolts/nuts — show them organised, in bulk, ready for professional use
- Never: plain grey background, floating product, AI art style, cinematic dramatic lighting
- Output ONLY the prompt — no explanation, no quotes"""

    try:
        prompt = generate_text(instruction, max_tokens=180).strip().strip('"')
        print(f"[generate_post] product image prompt: {prompt[:120]}")
        return prompt
    except Exception as e:
        print(f"[generate_post] product image prompt failed ({e}) — using fallback")
        return (
            f"Realistic DSLR commercial photography of {product_name} in a professional industrial setting, "
            f"organised and ready for use, natural lighting, sharp focus on product, "
            f"slightly blurred professional background, photorealistic, editorial feel"
        )


def _build_tech_image_prompt(repo_name: str, title: str, post_summary: str, context_text: str) -> str:
    """
    Build a tech image prompt that connects the technology to the actual supply business.
    Shows a procurement/supply workflow — not a generic tech startup dashboard.
    """
    instruction = f"""Write a FLUX image generation prompt (70-90 words) for an editorial photograph that shows modern B2B supply chain technology in action.

Post title: {title}
Platform/system: {repo_name}
Post summary: {post_summary[:300]}
Business context: Stellar Global Supplies — B2B supplier of stainless steel, mild steel, fasteners, and industrial products in India

The image should show technology being used to manage REAL B2B supply operations — not a generic tech startup scene.

Rules:
- Show a laptop or monitor in a professional office or procurement setting displaying a supply chain dashboard
- Screen must show supply-relevant UI elements: order status list with product names like "SS 304 Bolts — 500 units — In Transit", delivery tracking timeline, inventory levels, or approval workflow for bulk orders
- Include subtle industrial context in the background: a product catalogue, a small sample of industrial supplies on the desk, or a warehouse visible through a window
- Person at the desk (optional but good) — professional, Indian business context, reviewing the screen
- Natural office lighting, wooden desk, shallow depth of field, sharp screen
- Colour on screen: navy and gold UI elements
- Style: realistic DSLR editorial photograph, professional B2B context
- Include: "realistic photography", "DSLR", "natural light", "sharp screen", "professional office"
- Never: pure generic tech startup, no supply context, warehouse-only shot, dramatic cinematic lighting
- Output ONLY the prompt — no explanation, no quotes"""

    try:
        prompt = generate_text(instruction, max_tokens=180).strip().strip('"')
        print(f"[generate_post] tech image prompt: {prompt[:120]}")
        return prompt
    except Exception as e:
        print(f"[generate_post] tech image prompt failed ({e}) — using fallback")
        return (
            f"Realistic DSLR photo of a procurement professional in a modern office reviewing a B2B supply chain dashboard on a laptop, "
            f"screen shows order tracking for industrial supplies, navy and gold UI, natural window light, "
            f"industrial product catalogue visible on desk, shallow depth of field, sharp screen, photorealistic editorial photography"
        )


# ─── HANDLER ─────────────────────────────────────────────────────────────────

def handler(event, context):
    reset_cost_tracker()
    post_type    = event.get("type", "product")
    prompt       = event.get("prompt", "")
    order        = event.get("order", {})
    repo_name    = event.get("repo_name", "")
    order_id     = event.get("orderKey") or event.get("orderId") or event.get("order_id") or ""
    order_uuid   = event.get("orderUuid") or ""
    context_text = event.get("contextText", "")

    social_workflow_id = (
        event.get("socialWorkflowId")
        or event.get("social_workflow_id")
        or event.get("workflowRunId")
        or event.get("workflow_run_id")
        or None
    )

    print(f"[generate_post] START post_type={post_type!r} repo_name={repo_name!r} order_id={order_id!r}")

    # ── Dedup by order id ─────────────────────────────────────
    if post_type == "product" and order_id:
        db = get_client()
        order_id_filter = urllib.parse.quote(str(order_id), safe="")
        rows = db.select("social_posts", params=f"order_id=eq.{order_id_filter}&type=eq.product&limit=1")
        if rows:
            print(f"[generate_post] duplicate found — skipping")
            return {**event, "isDuplicate": True, "existingPostId": rows[0]["id"]}

    # ── Generate text content ─────────────────────────────────
    print(f"[generate_post] generating {post_type} post content")

    if post_type == "product":
        gen_prompt = f"""
Write a B2B marketing social media campaign for Stellar Global Supplies about this specific product.
{COMPANY_CONTEXT}
PRODUCT DETAILS:
- Name: {order.get('product_name', '')}
- Category: {order.get('product_category', '')}
- Description: {order.get('description', '')}
- Customer Segment: {order.get('customer_segment', '')}
{("Additional instructions: " + prompt) if prompt else ""}

Write persuasive advertising copy that makes procurement managers and plant managers want to contact us immediately for this product. Focus on business value, quality assurance, and reliability — not just product features.

Return JSON with these exact keys:
{{
  "title": "attention-grabbing post title (max 10 words) — sounds like an ad headline, not a catalogue entry",
  "facebook": "Facebook ad copy — 280 chars max. Lead with the buyer's pain or desire. End with a sharp CTA. 3-4 hashtags.",
  "instagram": "Instagram caption — 180 chars max. Visual and punchy. Speak directly to the buyer. 4-5 hashtags.",
  "linkedin": "Full LinkedIn post in PRODUCT POST MODE following the EXACT structure in the system prompt. Hook, Problem, Product, Who buys it, Why Stellar, CTA, Hashtags. Minimum 1500 characters. No em-dashes. No bullets.",
  "hashtags": ["product-specific tag", "industry tag", "B2BIndia", "Procurement", "StellarGlobalSupplies", "tag6", "tag7"]
}}"""

    else:
        context_section = f"\n\nPlatform/repository context:\n{context_text}" if context_text else ""
        gen_prompt = f"""
Write a B2B marketing social media campaign for Stellar Global Supplies that uses our technology platform to prove we are a reliable, modern supply partner.
{COMPANY_CONTEXT}
TECHNOLOGY DETAILS:
- Platform/Repository: {repo_name}
- Custom angle: {prompt if prompt else "Show how our technology makes us a better B2B supply partner for procurement teams and plant managers"}
{context_section}

CRITICAL GOAL: Every sentence should serve one purpose — making the reader want to contact Stellar Global Supplies for SS, MS, Fasteners, or Commercial supply needs. The technology is the proof of our capability, not the product itself.

Return JSON with these exact keys:
{{
  "title": "post title (max 10 words) — focus on business outcome for the buyer, not the technology",
  "facebook": "Facebook post — 280 chars max. Lead with a buyer benefit (faster delivery, live tracking, no supply gaps). End with supply CTA. 3-4 hashtags mixing tech and supply tags.",
  "instagram": "Instagram caption — 180 chars max. Business outcome first, tech second. 4-5 hashtags.",
  "linkedin": "Full LinkedIn post in TECH POST MODE following the EXACT structure in the system prompt. Hook on buyer outcome, Buyer's problem, What we built + how it helps them, Business outcomes with specific product names (SS/MS/Fasteners), Stellar as supply partner, CTA for supply enquiries, Hashtags mixing tech + supply + India. Minimum 1500 characters. No em-dashes. No bullets.",
  "hashtags": ["B2BSupplyChain", "OrderManagement", "StainlessSteel", "Fasteners", "IndustrialSupply", "Procurement", "StellarGlobalSupplies", "B2BIndia"]
}}"""

    content_data = generate_json(gen_prompt, system=SYSTEM, max_tokens=3000)
    print(f"[generate_post] text generation complete, title={content_data.get('title','')!r}")

    title   = content_data.get("title", "")
    summary = content_data.get("facebook") or content_data.get("linkedin", "")[:300]

    # ── Build image prompt (dedicated call, marketing approach) ───────────────
    if post_type == "product":
        img_prompt = _build_product_image_prompt(
            product_name=order.get("product_name", title),
            category=order.get("product_category", ""),
            description=order.get("description", ""),
            customer_segment=order.get("customer_segment", ""),
        )
    else:
        img_prompt = _build_tech_image_prompt(
            repo_name=repo_name,
            title=title,
            post_summary=summary,
            context_text=context_text,
        )

    content_key = f"generated-content/social-posts/{post_type}/{uuid.uuid4()}.json"
    content_url = upload_json_to_s3({
        "type":         post_type,
        "title":        title,
        "facebook":     content_data.get("facebook", ""),
        "instagram":    content_data.get("instagram", ""),
        "linkedin":     content_data.get("linkedin", ""),
        "hashtags":     content_data.get("hashtags", []),
        "image_prompt": img_prompt,
        "prompt":       prompt,
        "repo_name":    repo_name,
        "order":        order,
    }, content_key)

    # ── Generate image (non-blocking) ─────────────────────────
    image_url = None
    img_key   = None
    print(f"[generate_post] generating image")
    try:
        image_bytes = generate_image(img_prompt)
        if image_bytes:
            ext, content_type = image_ext_and_type(image_bytes)
            img_key   = f"social-posts/{post_type}/{uuid.uuid4()}{ext}"
            image_url = upload_image_to_s3(image_bytes, img_key, content_type=content_type)
            print(f"[generate_post] image uploaded: {img_key}")
        else:
            print("[generate_post] generate_image returned None — saving without image")
    except Exception as e:
        print(f"[generate_post] image step failed ({e}) — saving without image")

    # ── Build insert row ──────────────────────────────────────
    print(f"[generate_post] saving to Supabase")
    db = get_client()

    today      = datetime.now(timezone.utc).date()
    week_start = (today - timedelta(days=today.weekday())).isoformat()

    primary_platform = "linkedin" if post_type == "tech" else "facebook"
    caption = (
        content_data.get(primary_platform)
        or content_data.get("instagram")
        or content_data.get("facebook")
        or title
        or ""
    )

    raw_hashtags = content_data.get("hashtags", [])
    if isinstance(raw_hashtags, str):
        raw_hashtags = [h.lstrip("#") for h in raw_hashtags.split() if h]
    hashtags = [str(h).lstrip("#") for h in raw_hashtags if h] if raw_hashtags else []

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

    optional = {
        "type":            post_type,
        "title":           title or None,
        "content":         (content_data.get("facebook") or "")[:500] or None,
        "image_url":       image_url,
        "image_s3_key":    img_key,
        "image_prompt":    img_prompt or None,
        "platforms":       event.get("platforms") or {"facebook": True, "instagram": True, "linkedin": True},
        "order_id":        order_id if post_type == "product" and order_id else None,
        "repo_name":       repo_name if post_type == "tech" and repo_name else None,
        "prompt":          prompt or None,
        "workflow_run_id": event.get("workflowRunId") or event.get("workflow_run_id") or None,
        "content_s3_key":  content_key,
        "content_url":     content_url,
    }
    for k, v in optional.items():
        if v is not None:
            row[k] = v

    print(f"[generate_post] inserting row keys={list(row.keys())}")
    saved = db.insert("social_posts", row)

    print(f"[generate_post] DONE postId={saved['id']}")

    # Write cost tracking to workflow_run
    run_id = event.get("workflowRunId") or event.get("workflow_run_id")
    if run_id:
        try:
            cost = get_cost_summary()
            db.update("workflow_runs", {
                "input_tokens":  cost["input_tokens"],
                "output_tokens": cost["output_tokens"],
                "image_count":   cost["image_count"],
                "cost_usd":      cost["cost_usd"],
            }, params=f"id=eq.{run_id}")
            print(f"[generate_post] cost logged: ${cost['cost_usd']} ({cost['input_tokens']}in/{cost['output_tokens']}out tokens, {cost['image_count']} images)")
        except Exception as e:
            print(f"[generate_post] cost write failed: {e}")

    return {
        **event,
        "isDuplicate": False,
        "postId":      saved["id"],
        "post": {
            **saved,
            "title":          title,
            "content":        (content_data.get("facebook") or "")[:500],
            "content_s3_key": content_key,
            "content_url":    content_url,
            "image_url":      image_url,
            "hasImage":       image_url is not None,
        },
    }