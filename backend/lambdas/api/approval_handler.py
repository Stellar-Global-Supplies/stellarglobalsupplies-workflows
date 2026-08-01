"""
Lambda: approval_handler
GET  /approvals                      - list approvals
POST /approvals/{id}/approve         - approve with optional edits (dashboard)
POST /approvals/{id}/reject          - reject (dashboard)
POST /approvals/{id}/regenerate      - regenerate content with feedback
GET  /approvals/{id}/email-action    - one-click approve/reject from email
  ?token=<email_token>&action=approve|reject

Two gates:
  Gate 1 (approvalGate=save):
    approve → set post to approved_manual, resume Step Function
    reject  → DELETE post from social_posts (was only a pending draft)

  Gate 2 (approvalGate=publish):
    approve → invoke post_to_platforms directly (async)
    reject  → revert post to approved_manual (can re-trigger publish)

payment_followup:
    approve → invoke send_payment_email Lambda directly
    reject  → mark rejected, no action

Bug fix: Gate 1 reject now DELETES social_post row instead of marking rejected.
"""
import sys, os, json, re
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import boto3
from datetime import datetime, timezone
from shared.supabase_client import get_client
from shared.utils import ok, err, now_iso, send_task_success, send_task_failure
from shared.bedrock_client import generate_json


def _approval_id_from_event(event):
    path_params = event.get("pathParameters") or {}
    approval_id = path_params.get("id")
    if approval_id:
        return approval_id
    raw_path = event.get("rawPath") or event.get("path") or ""
    match = re.search(r"/approvals/([^/]+)/(approve|reject|regenerate|email-action)$", raw_path)
    return match.group(1) if match else None


def _http_method(event):
    return (
        event.get("httpMethod")
        or (event.get("requestContext") or {}).get("http", {}).get("method")
        or event.get("method")
        or "GET"
    )


def _persist_edits(db, item, edits):
    payload    = item.get("payload", {})
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
    lc      = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    fn_name = os.environ.get("POST_TO_PLATFORMS_FUNCTION_NAME", "stellar-post-to-platforms")
    payload = json.dumps({"postId": post_id, "post": post}).encode()
    print(f"[approval] invoking {fn_name} for post {post_id}")
    resp = lc.invoke(FunctionName=fn_name, InvocationType="Event", Payload=payload)
    print(f"[approval] post_to_platforms status={resp.get('StatusCode')}")


def _html_page(message: str, is_error: bool) -> dict:
    colour = "#EF4444" if is_error else "#10B981"
    icon   = "✕" if is_error else "✓"
    return {
        "statusCode": 200,
        "headers":    {"Content-Type": "text/html"},
        "body": f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Stellar Approval</title></head>
<body style="margin:0;padding:40px;font-family:Arial,sans-serif;
             background:#f1f5f9;text-align:center">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;
              padding:40px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    <div style="font-size:48px;color:{colour}">{icon}</div>
    <h2 style="color:#0A2547;margin:16px 0 8px">{message}</h2>
    <p style="color:#64748B;font-size:14px">
      <a href="https://app.stellarglobalsupplies.com/approvals"
         style="color:#1565C0">View all approvals in the dashboard</a>
    </p>
    <p style="color:#94A3B8;font-size:12px;margin-top:24px">
      Stellar Global Supplies &middot; stellarglobalsupplies.com
    </p>
  </div>
</body></html>"""
    }


def _do_approve(db, item, approval_id, reviewer_note, edits, now):
    payload         = item.get("payload", {})
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}
    approval_gate   = payload.get("approvalGate", "save")
    wf_type         = item.get("workflow_type", "")
    workflow_run_id = item.get("workflow_run_id") or payload.get("workflowRunId")

    edited_payload = {**payload}
    if edits:
        _persist_edits(db, item, edits)
        for key in ("post", "blog", "email"):
            if key in edited_payload and isinstance(edited_payload[key], dict):
                edited_payload[key] = {**edited_payload[key], **edits.get(key, {})}
        edited_payload.update({k: v for k, v in edits.items() if k not in ("post", "blog", "email")})

    # ── Payment follow-up ─────────────────────────────────────────────────────
    if wf_type == "payment_followup":
        order      = edited_payload.get("order", {})
        email_data = edited_payload.get("email", {})
        if edits.get("email"):
            email_data = {**email_data, **edits["email"]}
        try:
            lc = boto3.client("lambda")
            lc.invoke(
                FunctionName=os.environ.get("SEND_PAYMENT_EMAIL_FUNCTION_NAME", "stellar-wf-prod-send-payment-email"),
                InvocationType="RequestResponse",
                Payload=json.dumps({"order": order, "email": email_data, "approvalId": approval_id}).encode(),
            )
            print(f"[approval] payment email sent for approval={approval_id}")
        except Exception as e:
            return err(f"Failed to send payment email: {str(e)}", 500)

    # ── Gate 1 — Save ────────────────────────────────────────────────────────
    elif approval_gate == "save":
        try:
            send_task_success(item["task_token"], {"approved": True, "note": reviewer_note, **edited_payload})
        except Exception as e:
            if "TaskTimedOut" in str(e) or "InvalidToken" in str(e):
                db.update("approval_queue", {"status": "expired"}, params=f"id=eq.{approval_id}")
                return err("Approval token expired — workflow timed out", 410)
            raise
        post_id = payload.get("postId") or (payload.get("post") or {}).get("id")
        if post_id and wf_type in ("social_tech", "social_product"):
            try:
                db.update("social_posts", {"status": "approved_manual"}, params=f"id=eq.{post_id}")
            except Exception as e:
                print(f"[approval] could not update post status: {e}")

    # ── Gate 2 — Publish ─────────────────────────────────────────────────────
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
        "status":        "approved",
        "review_note":   reviewer_note,
        "reviewed_at":   now,
        "token_used_at": now,
    }, params=f"id=eq.{approval_id}")

    if workflow_run_id:
        try:
            db.update("workflow_runs", {
                "status":       "succeeded",
                "completed_at": now,
                "output":       {"approved": True, "note": reviewer_note,
                                 "approval_id": approval_id, "gate": approval_gate},
            }, params=f"id=eq.{workflow_run_id}")
        except Exception as e:
            print(f"[approval] workflow_runs update failed: {e}")

    return ok({"message": "Approved", "approvalId": approval_id,
               "gate": approval_gate, "edited": bool(edits)})


def _do_reject(db, item, approval_id, reviewer_note, now):
    payload         = item.get("payload", {})
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}
    approval_gate   = payload.get("approvalGate", "save")
    wf_type         = item.get("workflow_type", "")
    workflow_run_id = item.get("workflow_run_id") or payload.get("workflowRunId")

    # Attempt to resume SF with failure (may already be expired)
    try:
        send_task_failure(item["task_token"], "Rejected", reviewer_note or "Rejected by reviewer")
    except Exception:
        pass

    if approval_gate == "save":
        post_id = payload.get("postId") or (payload.get("post") or {}).get("id")
        if post_id and wf_type in ("social_tech", "social_product"):
            # BUG FIX: DELETE — post was a pending draft, should never be saved
            try:
                db.delete("social_posts", params=f"id=eq.{post_id}")
                print(f"[approval] Gate1 reject — deleted social_post {post_id}")
            except Exception as e:
                print(f"[approval] delete failed ({e}), marking rejected instead")
                try:
                    db.update("social_posts", {"status": "rejected"}, params=f"id=eq.{post_id}")
                except Exception:
                    pass

    elif approval_gate == "publish":
        # Keep post as approved_manual — user can re-trigger publish later
        post_id = payload.get("postId") or (payload.get("post") or {}).get("id")
        if post_id and wf_type in ("social_tech", "social_product"):
            try:
                db.update("social_posts", {"status": "approved_manual"}, params=f"id=eq.{post_id}")
            except Exception as e:
                print(f"[approval] could not revert post to approved_manual: {e}")

    db.update("approval_queue", {
        "status":        "rejected",
        "review_note":   reviewer_note,
        "reviewed_at":   now,
        "token_used_at": now,
    }, params=f"id=eq.{approval_id}")

    if workflow_run_id:
        try:
            db.update("workflow_runs", {
                "status":       "failed",
                "completed_at": now,
                "error_msg":    reviewer_note or "Rejected by reviewer",
                "output":       {"approved": False, "note": reviewer_note,
                                 "approval_id": approval_id, "gate": approval_gate},
            }, params=f"id=eq.{workflow_run_id}")
        except Exception as e:
            print(f"[approval] workflow_runs update failed: {e}")

    return ok({"message": "Rejected", "approvalId": approval_id})


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return ok({})

    method      = _http_method(event).upper()
    path        = event.get("path") or event.get("rawPath", "")
    approval_id = _approval_id_from_event(event)
    qs          = event.get("queryStringParameters") or {}
    db          = get_client()
    now         = now_iso()

    # ── GET /approvals ────────────────────────────────────────────────────────
    if method == "GET" and not path.endswith("/email-action"):
        status_filter = qs.get("status", "pending")
        wf_filter     = qs.get("workflow_type", "")
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

    # ── GET /approvals/{id}/email-action?token=xxx&action=approve|reject ──────
    if path.endswith("/email-action"):
        token  = qs.get("token", "")
        action = qs.get("action", "")

        if not token or not action:
            return _html_page("Missing token or action in the link.", is_error=True)

        if item.get("email_token") != token:
            return _html_page("Invalid link — token does not match.", is_error=True)

        expires_at_str = item.get("token_expires_at")
        if expires_at_str:
            expires_at = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) > expires_at:
                return _html_page(
                    "This link has expired (1 hour limit). Please use the dashboard to approve.",
                    is_error=True,
                )

        if item.get("token_used_at"):
            return _html_page("This link has already been used.", is_error=True)

        if item["status"] != "pending":
            return _html_page(f"This approval was already {item['status']}.", is_error=False)

        if action == "approve":
            _do_approve(db, item, approval_id, "Approved via email", {}, now)
            return _html_page("Approved! The workflow is continuing.", is_error=False)
        elif action == "reject":
            _do_reject(db, item, approval_id, "Rejected via email", now)
            return _html_page("Rejected. The content has been discarded.", is_error=False)
        else:
            return _html_page(f"Unknown action: {action}", is_error=True)

    # ── Dashboard actions — require pending status ─────────────────────────────
    if item["status"] != "pending":
        return err(f"Approval already {item['status']}")

    body = {}
    if event.get("body"):
        try:
            body = json.loads(event["body"])
        except Exception:
            pass

    reviewer_note = body.get("note", "")
    edits         = body.get("edits", {})

    # ── POST /approvals/{id}/approve ──────────────────────────────────────────
    if path.endswith("/approve"):
        return _do_approve(db, item, approval_id, reviewer_note, edits, now)

    # ── POST /approvals/{id}/reject ───────────────────────────────────────────
    elif path.endswith("/reject"):
        return _do_reject(db, item, approval_id, reviewer_note, now)

    # ── POST /approvals/{id}/regenerate ───────────────────────────────────────
    elif path.endswith("/regenerate"):
        feedback = body.get("feedback", "").strip()
        if not feedback:
            return err("feedback is required")

        payload = item.get("payload", {})
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except Exception:
                payload = {}

        post = payload.get("post", {})
        blog = payload.get("blog", {})

        if post:
            REGEN_SYSTEM = """You are a senior B2B marketing copywriter for Stellar Global Supplies.
Rewrite the provided social media post content based on the reviewer's feedback.
Return ONLY valid JSON with keys: linkedin, facebook, instagram.
Keep the same product/topic but apply the feedback exactly.
LinkedIn: 1500+ chars, structured paragraphs, no bullets, no em-dashes.
Facebook/Instagram: under 300 chars with 3-5 hashtags."""

            regen_prompt = f"""Original content:
LINKEDIN: {post.get('linkedin', post.get('content',''))[:800]}
FACEBOOK: {post.get('facebook','')}
INSTAGRAM: {post.get('instagram','')}

Reviewer feedback: {feedback}

Return JSON: {{ "linkedin": "...", "facebook": "...", "instagram": "..." }}"""

            try:
                regen = generate_json(regen_prompt, system=REGEN_SYSTEM, max_tokens=3000)
            except Exception as e:
                return err(f"Regeneration failed: {str(e)}", 500)

            post_id = post.get("id") or payload.get("postId")
            if post_id:
                try:
                    db.update("social_posts", {
                        "content":     (regen.get("facebook") or "")[:500],
                        "caption":     (regen.get("facebook") or "")[:500],
                        "raw_caption": (regen.get("facebook") or "")[:500],
                    }, params=f"id=eq.{post_id}")
                except Exception as e:
                    print(f"[approval] regenerate DB update failed: {e}")

            new_payload = {**payload, "post": {**post, **regen}}
            db.update("approval_queue", {"payload": new_payload}, params=f"id=eq.{approval_id}")
            return ok({"message": "Content regenerated", "feedback": feedback, "content": regen})

        elif blog:
            BLOG_REGEN_SYSTEM = """You are a professional content writer for Stellar Global Supplies.
Rewrite the blog post based on the reviewer's feedback.
Return ONLY valid JSON with keys: title, excerpt, content (full markdown).
Apply the feedback exactly while keeping the same topic."""

            regen_prompt = f"""Original blog:
TITLE: {blog.get('title','')}
EXCERPT: {blog.get('excerpt','')}
CONTENT (first 1000 chars): {blog.get('content','')[:1000]}

Reviewer feedback: {feedback}

Return JSON: {{ "title": "...", "excerpt": "...", "content": "full markdown..." }}"""

            try:
                regen = generate_json(regen_prompt, system=BLOG_REGEN_SYSTEM, max_tokens=4000)
            except Exception as e:
                return err(f"Regeneration failed: {str(e)}", 500)

            blog_id = blog.get("id") or payload.get("blogId")
            if blog_id:
                try:
                    db.update("blog_posts", {
                        k: v for k, v in regen.items()
                        if k in ("title", "content", "excerpt")
                    }, params=f"id=eq.{blog_id}")
                except Exception as e:
                    print(f"[approval] regenerate blog DB update failed: {e}")

            new_payload = {**payload, "blog": {**blog, **regen}}
            db.update("approval_queue", {"payload": new_payload}, params=f"id=eq.{approval_id}")
            return ok({"message": "Blog regenerated", "feedback": feedback, "content": regen})

        return err("No regeneratable content found in this approval")

    return err("Invalid action", 404)