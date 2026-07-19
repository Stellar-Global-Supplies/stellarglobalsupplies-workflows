"""
Lambda: approval_handler
GET    /approvals                 - list pending approvals
POST   /approvals/{id}/approve    - approve (with optional edits) and send task success
POST   /approvals/{id}/reject     - reject and send task failure

Approve body (all optional):
  {
    "note":  "reviewer note",
    "edits": {
      "post":  { "facebook": "...", "instagram": "...", "linkedin": "...", "caption": "..." },
      "blog":  { "title": "...", "content": "..." },
      "email": { "subject": "...", "body": "..." }
    }
  }

edits are merged into the Step Functions payload so the next state
receives the edited content, and persisted back to the source DB record.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
import re
import boto3
from shared.supabase_client import get_client
from shared.utils import ok, err, now_iso, send_task_success, send_task_failure


def _approval_id_from_event(event):
    path_params = event.get("pathParameters") or {}
    approval_id = path_params.get("id")
    if approval_id:
        return approval_id
    raw_path = event.get("rawPath") or event.get("path") or ""
    match = re.search(r"/approvals/([^/]+)/(approve|reject)$", raw_path)
    return match.group(1) if match else None


def _http_method_from_event(event):
    return (
        event.get("httpMethod")
        or (event.get("requestContext") or {}).get("http", {}).get("method")
        or event.get("method")
        or "GET"
    )


def _persist_edits(db, item, edits):
    """Write reviewer edits back to the source record (social_posts / blog_posts)."""
    payload       = item.get("payload", {})
    wf_type       = item.get("workflow_type", "")

    # ── Social post edits ────────────────────────────────────────────────────
    post_edits = edits.get("post", {})
    if post_edits:
        post_id = (payload.get("post") or {}).get("id") or payload.get("postId")
        if post_id:
            update = {}
            # caption is the primary/lead platform text stored in social_posts
            if "caption" in post_edits:
                update["caption"]     = post_edits["caption"]
                update["raw_caption"] = post_edits["caption"]
            # content is the short preview text
            if "facebook" in post_edits:
                update["content"] = post_edits["facebook"][:500]
            try:
                db.update("social_posts", update, params=f"id=eq.{post_id}")
                print(f"[approval] persisted post edits to social_posts {post_id}")
            except Exception as e:
                print(f"[approval] warning: could not persist post edits: {e}")

    # ── Blog post edits ──────────────────────────────────────────────────────
    blog_edits = edits.get("blog", {})
    if blog_edits:
        blog_id = (payload.get("blog") or {}).get("id") or payload.get("blogId")
        if blog_id:
            update = {}
            if "title"   in blog_edits: update["title"]   = blog_edits["title"]
            if "content" in blog_edits: update["content"]  = blog_edits["content"]
            if "excerpt" in blog_edits: update["excerpt"]  = blog_edits["excerpt"]
            try:
                db.update("blog_posts", update, params=f"id=eq.{blog_id}")
                print(f"[approval] persisted blog edits to blog_posts {blog_id}")
            except Exception as e:
                print(f"[approval] warning: could not persist blog edits: {e}")


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return ok({})

    method      = _http_method_from_event(event).upper()
    path        = event.get("path") or event.get("rawPath", "")
    approval_id = _approval_id_from_event(event)

    db = get_client()

    # GET /approvals
    if method == "GET":
        status_filter = (event.get("queryStringParameters") or {}).get("status", "pending")
        wf_filter     = (event.get("queryStringParameters") or {}).get("workflow_type", "")
        params = f"status=eq.{status_filter}&order=created_at.desc&limit=50"
        if wf_filter:
            params += f"&workflow_type=eq.{wf_filter}"
        rows = db.select("approval_queue", params=params)
        return ok({"approvals": rows, "count": len(rows)})

    # POST /approvals/{id}/approve or /reject
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

    reviewer_note = body.get("note", "")
    edits         = body.get("edits", {})
    now           = now_iso()

    if path.endswith("/approve"):
        # Build edited payload — merge reviewer edits into sub-objects
        payload        = item.get("payload", {})
        edited_payload = {**payload}

        if edits:
            _persist_edits(db, item, edits)
            for key in ("post", "blog", "email"):
                if key in edited_payload and isinstance(edited_payload[key], dict):
                    edited_payload[key] = {**edited_payload[key], **edits.get(key, {})}
            # Also merge any top-level edits
            edited_payload.update({k: v for k, v in edits.items() if k not in ("post", "blog", "email")})

        try:
            send_task_success(item["task_token"], {
                "approved": True,
                "note":     reviewer_note,
                **edited_payload,
            })
        except Exception as e:
            if "TaskTimedOut" in str(e) or "InvalidToken" in str(e):
                db.update("approval_queue", {"status": "expired"}, params=f"id=eq.{approval_id}")
                return err("Approval token expired - workflow timed out", 410)
            raise

        db.update("approval_queue", {
            "status":      "approved",
            "review_note": reviewer_note,
            "reviewed_at": now,
        }, params=f"id=eq.{approval_id}")

        workflow_run_id = item.get("workflow_run_id") or item.get("payload", {}).get("workflowRunId")
        if workflow_run_id:
            db.update("workflow_runs", {
                "status":       "succeeded",
                "completed_at":  now,
                "output": {
                    "approved":    True,
                    "note":        reviewer_note,
                    "approval_id": approval_id,
                    "edited":      bool(edits),
                },
            }, params=f"id=eq.{workflow_run_id}")

        return ok({"message": "Approved", "approvalId": approval_id, "edited": bool(edits)})

    elif path.endswith("/reject"):
        try:
            send_task_failure(item["task_token"], "Rejected", reviewer_note or "Rejected by reviewer")
        except Exception:
            pass

        db.update("approval_queue", {
            "status":      "rejected",
            "review_note": reviewer_note,
            "reviewed_at": now,
        }, params=f"id=eq.{approval_id}")

        workflow_run_id = item.get("workflow_run_id") or item.get("payload", {}).get("workflowRunId")
        if workflow_run_id:
            db.update("workflow_runs", {
                "status":       "failed",
                "completed_at":  now,
                "error_msg":    reviewer_note or "Rejected by reviewer",
                "output": {
                    "approved":    False,
                    "note":        reviewer_note,
                    "approval_id": approval_id,
                },
            }, params=f"id=eq.{workflow_run_id}")

        return ok({"message": "Rejected", "approvalId": approval_id})

    return err("Invalid action", 404)