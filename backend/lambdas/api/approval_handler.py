"""
Lambda: approval_handler
GET  /approvals                 - list approvals
POST /approvals/{id}/approve    - approve with optional edits
POST /approvals/{id}/reject     - reject

Two gates:
  Gate 1 (approvalGate=save):    approve → saves content (approved_manual), resumes SF
  Gate 2 (approvalGate=publish): approve → invokes post_to_platforms directly

Approve body: { "note": "...", "edits": { "post":{...}, "blog":{...}, "email":{...} } }
"""
import sys, os, json, re
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import boto3
from shared.supabase_client import get_client
from shared.utils import ok, err, now_iso, send_task_success, send_task_failure
from shared.bedrock_client import generate_json, generate_text


def _approval_id_from_event(event):
    path_params = event.get("pathParameters") or {}
    approval_id = path_params.get("id")
    if approval_id:
        return approval_id
    raw_path = event.get("rawPath") or event.get("path") or ""
    match = re.search(r"/approvals/([^/]+)/(approve|reject|regenerate)$", raw_path)
    return match.group(1) if match else None


def _http_method(event):
    return (
        event.get("httpMethod")
        or (event.get("requestContext") or {}).get("http", {}).get("method")
        or event.get("method")
        or "GET"
    )


def _persist_edits(db, item, edits):
    payload = item.get("payload", {})
    post_edits = edits.get("post", {})
    if post_edits:
        post_id = (payload.get("post") or {}).get("id") or payload.get("postId")
        if post_id:
            update = {}
            if "caption"  in post_edits: update["caption"] = update["raw_caption"] = post_edits["caption"]
            if "facebook" in post_edits: update["content"] = post_edits["facebook"][:500]
            try:
                db.update("social_posts", update, params=f"id=eq.{post_id}")
            except Exception as e:
                print(f"[approval] post edit persist failed: {e}")

    blog_edits = edits.get("blog", {})
    if blog_edits:
        blog_id = (payload.get("blog") or {}).get("id") or payload.get("blogId")
        if blog_id:
            update = {k: v for k, v in blog_edits.items() if k in ("title", "content", "excerpt")}
            try:
                db.update("blog_posts", update, params=f"id=eq.{blog_id}")
            except Exception as e:
                print(f"[approval] blog edit persist failed: {e}")


def _invoke_post_to_platforms(post_id, post):
    lambda_client = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    fn_name       = os.environ.get("POST_TO_PLATFORMS_FUNCTION_NAME", "stellar-post-to-platforms")
    payload       = json.dumps({"postId": post_id, "post": post}).encode()
    print(f"[approval] invoking {fn_name} for post {post_id}")
    resp = lambda_client.invoke(FunctionName=fn_name, InvocationType="Event", Payload=payload)
    print(f"[approval] post_to_platforms status={resp.get('StatusCode')}")


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return ok({})

    method      = _http_method(event).upper()
    path        = event.get("path") or event.get("rawPath", "")
    approval_id = _approval_id_from_event(event)
    db          = get_client()

    # GET /approvals
    if method == "GET":
        status_filter = (event.get("queryStringParameters") or {}).get("status", "pending")
        wf_filter     = (event.get("queryStringParameters") or {}).get("workflow_type", "")
        params = f"status=eq.{status_filter}&order=created_at.desc&limit=50"
        if wf_filter:
            params += f"&workflow_type=eq.{wf_filter}"
        rows = db.select("approval_queue", params=params)
        return ok({"approvals": rows, "count": len(rows)})

    if not approval_id:
        return err("Missing approval ID")

    rows = db.select("approval_queue", params=f"id=eq.{approval_id}&limit=1")
    if not rows:
        return err("Approval not found", 404)

    item = rows[0]
    if item["status"] != "pending":
        return err(f"Approval already {item['status']}")

    body = {}
    if event.get("body"):
        try:
            body = json.loads(event["body"])
        except Exception:
            pass

    reviewer_note   = body.get("note", "")
    edits           = body.get("edits", {})
    now             = now_iso()
    payload         = item.get("payload", {})
    approval_gate   = payload.get("approvalGate", "save")
    wf_type         = item.get("workflow_type", "")
    workflow_run_id = item.get("workflow_run_id") or payload.get("workflowRunId")

    # ── APPROVE ───────────────────────────────────────────────────────────────
    if path.endswith("/approve"):
        edited_payload = {**payload}
        if edits:
            _persist_edits(db, item, edits)
            for key in ("post", "blog", "email"):
                if key in edited_payload and isinstance(edited_payload[key], dict):
                    edited_payload[key] = {**edited_payload[key], **edits.get(key, {})}
            edited_payload.update({k: v for k, v in edits.items() if k not in ("post", "blog", "email")})

        # Gate 1 — Save
        if approval_gate == "save":
            # ── Payment follow-up: send email directly (no task token) ────────
            if wf_type == "payment_followup":
                order      = edited_payload.get("order", {})
                email_data = edited_payload.get("email", {})
                # Apply any edits the reviewer made to subject/body
                if edits.get("email"):
                    email_data = {**email_data, **edits["email"]}
                try:
                    lambda_client = boto3.client("lambda")
                    lambda_client.invoke(
                        FunctionName=os.environ.get("SEND_PAYMENT_EMAIL_FUNCTION_NAME", "send-payment-email"),
                        InvocationType="RequestResponse",
                        Payload=json.dumps({
                            "order":      order,
                            "email":      email_data,
                            "approvalId": approval_id,
                        }).encode(),
                    )
                    print(f"[approval] payment email sent for approval={approval_id}")
                except Exception as e:
                    return err(f"Failed to send payment email: {str(e)}", 500)
            else:
                try:
                    send_task_success(item["task_token"], {"approved": True, "note": reviewer_note, **edited_payload})
                except Exception as e:
                    if "TaskTimedOut" in str(e) or "InvalidToken" in str(e):
                        db.update("approval_queue", {"status": "expired"}, params=f"id=eq.{approval_id}")
                        return err("Approval token expired — workflow timed out", 410)
                    raise
                # Set post to approved_manual (ready to publish from Content page)
                post_id = payload.get("postId") or (payload.get("post") or {}).get("id")
                if post_id and wf_type in ("social_tech", "social_product"):
                    try:
                        db.update("social_posts", {"status": "approved_manual"}, params=f"id=eq.{post_id}")
                    except Exception as e:
                        print(f"[approval] could not update post status: {e}")

        # Gate 2 — Publish
        elif approval_gate == "publish":
            post    = edited_payload.get("post", {})
            post_id = edited_payload.get("postId") or post.get("id")
            if not post_id:
                return err("Cannot publish — no postId in approval payload")
            try:
                db.update("social_posts", {"status": "publishing"}, params=f"id=eq.{post_id}")
            except Exception as e:
                print(f"[approval] could not set publishing status: {e}")
            try:
                _invoke_post_to_platforms(post_id, {**post, **edited_payload.get("post", {})})
            except Exception as e:
                db.update("social_posts", {"status": "publish_failed"}, params=f"id=eq.{post_id}")
                return err(f"Failed to invoke publisher: {e}", 500)

        db.update("approval_queue", {
            "status": "approved", "review_note": reviewer_note, "reviewed_at": now,
        }, params=f"id=eq.{approval_id}")

        if workflow_run_id:
            db.update("workflow_runs", {
                "status": "succeeded", "completed_at": now,
                "output": {"approved": True, "note": reviewer_note, "approval_id": approval_id, "gate": approval_gate},
            }, params=f"id=eq.{workflow_run_id}")

        return ok({"message": "Approved", "approvalId": approval_id, "gate": approval_gate, "edited": bool(edits)})

    # ── REJECT ────────────────────────────────────────────────────────────────
    elif path.endswith("/reject"):
        try:
            send_task_failure(item["task_token"], "Rejected", reviewer_note or "Rejected by reviewer")
        except Exception:
            pass

        if approval_gate == "save":
            post_id = payload.get("postId") or (payload.get("post") or {}).get("id")
            if post_id and wf_type in ("social_tech", "social_product"):
                try:
                    db.update("social_posts", {"status": "rejected"}, params=f"id=eq.{post_id}")
                except Exception as e:
                    print(f"[approval] could not set rejected status: {e}")

        db.update("approval_queue", {
            "status": "rejected", "review_note": reviewer_note, "reviewed_at": now,
        }, params=f"id=eq.{approval_id}")

        if workflow_run_id:
            db.update("workflow_runs", {
                "status": "failed", "completed_at": now,
                "error_msg": reviewer_note or "Rejected by reviewer",
                "output": {"approved": False, "note": reviewer_note, "approval_id": approval_id, "gate": approval_gate},
            }, params=f"id=eq.{workflow_run_id}")

        return ok({"message": "Rejected", "approvalId": approval_id})

    # ── REGENERATE ────────────────────────────────────────────────────────────
    # POST /approvals/{id}/regenerate
    # Body: { "feedback": "Too salesy, make it more factual" }
    # Re-runs Bedrock with feedback appended, updates social_posts / blog_posts in place,
    # updates the approval_queue payload so the reviewer sees fresh content.
    if path.endswith("/regenerate"):
        feedback = body.get("feedback", "").strip()
        if not feedback:
            return err("feedback is required")

        payload  = item.get("payload", {})
        post     = payload.get("post", {})
        blog     = payload.get("blog", {})

        if post:
            # Regenerate social post content
            existing_linkedin  = post.get("linkedin",  post.get("content", ""))
            existing_facebook  = post.get("facebook",  "")
            existing_instagram = post.get("instagram", "")
            title              = post.get("title", "")

            REGEN_SYSTEM = """You are a senior B2B marketing copywriter for Stellar Global Supplies.
Rewrite the provided social media post content based on the reviewer's feedback.
Return ONLY valid JSON with keys: linkedin, facebook, instagram.
Keep the same product/topic but apply the feedback exactly.
LinkedIn: 1500+ chars, structured paragraphs, no bullets, no em-dashes.
Facebook/Instagram: under 300 chars with 3-5 hashtags."""

            regen_prompt = f"""Original content:
LINKEDIN: {existing_linkedin[:800]}
FACEBOOK: {existing_facebook}
INSTAGRAM: {existing_instagram}

Reviewer feedback: {feedback}

Rewrite all three platform versions applying this feedback exactly.
Return JSON: {{ "linkedin": "...", "facebook": "...", "instagram": "..." }}"""

            try:
                regen = generate_json(regen_prompt, system=REGEN_SYSTEM, max_tokens=3000)
            except Exception as e:
                return err(f"Regeneration failed: {str(e)}", 500)

            post_id = post.get("id") or payload.get("postId")
            if post_id:
                try:
                    db.update("social_posts", {
                        "linkedin":    regen.get("linkedin", existing_linkedin),
                        "facebook":    regen.get("facebook", existing_facebook),
                        "instagram":   regen.get("instagram", existing_instagram),
                        "content":     (regen.get("facebook") or "")[:500],
                        "caption":     (regen.get("facebook") or "")[:500],
                        "raw_caption": (regen.get("facebook") or "")[:500],
                    }, params=f"id=eq.{post_id}")
                except Exception as e:
                    print(f"[approval] regenerate post DB update failed: {e}")

            # Update approval_queue payload with fresh content
            new_payload = {**payload, "post": {**post, **regen, "linkedin": regen.get("linkedin", existing_linkedin)}}
            db.update("approval_queue", {"payload": new_payload}, params=f"id=eq.{approval_id}")

            return ok({
                "message":  "Content regenerated",
                "feedback": feedback,
                "content":  regen,
            })

        elif blog:
            existing_content = blog.get("content", "")
            existing_title   = blog.get("title", "")
            existing_excerpt = blog.get("excerpt", "")

            BLOG_REGEN_SYSTEM = """You are a professional content writer for Stellar Global Supplies.
Rewrite the blog post based on the reviewer's feedback.
Return ONLY valid JSON with keys: title, excerpt, content (full markdown).
Apply the feedback exactly while keeping the same topic and SEO value."""

            regen_prompt = f"""Original blog:
TITLE: {existing_title}
EXCERPT: {existing_excerpt}
CONTENT (first 1000 chars): {existing_content[:1000]}

Reviewer feedback: {feedback}

Rewrite the full blog applying this feedback.
Return JSON: {{ "title": "...", "excerpt": "...", "content": "full markdown..." }}"""

            try:
                regen = generate_json(regen_prompt, system=BLOG_REGEN_SYSTEM, max_tokens=4000)
            except Exception as e:
                return err(f"Regeneration failed: {str(e)}", 500)

            blog_id = blog.get("id") or payload.get("blogId")
            if blog_id:
                try:
                    db.update("blog_posts", {
                        "title":   regen.get("title",   existing_title),
                        "excerpt": regen.get("excerpt", existing_excerpt),
                        "content": regen.get("content", existing_content),
                    }, params=f"id=eq.{blog_id}")
                except Exception as e:
                    print(f"[approval] regenerate blog DB update failed: {e}")

            new_payload = {**payload, "blog": {**blog, **regen}}
            db.update("approval_queue", {"payload": new_payload}, params=f"id=eq.{approval_id}")

            return ok({
                "message":  "Blog regenerated",
                "feedback": feedback,
                "content":  regen,
            })

        return err("No regeneratable content found in this approval")

    return err("Invalid action", 404)