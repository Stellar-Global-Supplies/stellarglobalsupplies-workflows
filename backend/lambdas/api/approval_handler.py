"""
Lambda: approval_handler
GET    /approvals                 - list pending approvals
POST   /approvals/{id}/approve    - approve and send task success to Step Functions
POST   /approvals/{id}/reject     - reject and send task failure
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
import boto3
from shared.supabase_client import get_client
from shared.utils import ok, err, now_iso, send_task_success, send_task_failure


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return ok({})

    method      = event.get("httpMethod", "GET")
    path        = event.get("path", "")
    path_params = event.get("pathParameters") or {}
    approval_id = path_params.get("id")

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
    now           = now_iso()

    if path.endswith("/approve"):
        try:
            send_task_success(item["task_token"], {
                "approved":  True,
                "note":      reviewer_note,
                **item.get("payload", {}),
            })
        except Exception as e:
            # Token might have expired
            if "TaskTimedOut" in str(e) or "InvalidToken" in str(e):
                db.update("approval_queue", {"status": "expired"}, params=f"id=eq.{approval_id}")
                return err("Approval token expired - workflow timed out", 410)
            raise

        db.update("approval_queue", {
            "status":      "approved",
            "review_note": reviewer_note,
            "reviewed_at": now,
        }, params=f"id=eq.{approval_id}")

        return ok({"message": "Approved", "approvalId": approval_id})

    elif path.endswith("/reject"):
        try:
            send_task_failure(item["task_token"], "Rejected", reviewer_note or "Rejected by reviewer")
        except Exception:
            pass  # Best effort

        db.update("approval_queue", {
            "status":      "rejected",
            "review_note": reviewer_note,
            "reviewed_at": now,
        }, params=f"id=eq.{approval_id}")

        return ok({"message": "Rejected", "approvalId": approval_id})

    return err("Invalid action", 404)
