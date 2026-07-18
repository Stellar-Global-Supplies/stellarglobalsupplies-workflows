"""
Lambda: data_handler
GET /data/leads          - list leads
GET /data/social-posts   - list social posts
GET /data/blog-posts     - list blog posts
GET /data/workflow-runs  - list workflow runs
GET /data/dashboard      - aggregated stats
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import boto3
import json
from shared.supabase_client import get_client
from shared.utils import ok, err


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return ok({})

    path    = event.get("path") or event.get("rawPath", "")
    qs      = event.get("queryStringParameters") or {}
    db      = get_client()
    limit   = int(qs.get("limit", 50))
    offset  = int(qs.get("offset", 0))
    status  = qs.get("status", "")

    def with_filters(base_params: str, table_status: str = "") -> str:
        params = base_params
        if table_status:
            params += f"&status=eq.{table_status}"
        params += f"&limit={limit}&offset={offset}"
        return params

    if "/data/leads" in path:
        params = with_filters("order=created_at.desc", status)
        rows   = db.select("leads", params=params)
        return ok({"leads": rows, "count": len(rows)})

    elif "/data/social-posts" in path:
        post_type = qs.get("type", "")
        base = "order=created_at.desc"
        if post_type:
            base += f"&type=eq.{post_type}"
        params = with_filters(base, status)
        rows   = db.select("social_posts", params=params)
        return ok({"posts": rows, "count": len(rows)})

    elif "/data/blog-posts" in path:
        params = with_filters("order=created_at.desc", status)
        rows   = db.select("blog_posts", params=params)
        return ok({"blogs": rows, "count": len(rows)})

    elif "/data/workflow-runs" in path:
        wf_type = qs.get("workflow_type", "")
        base = "order=started_at.desc"
        if wf_type:
            base += f"&workflow_type=eq.{wf_type}"
        params = with_filters(base, status)
        rows   = db.select("workflow_runs", params=params)
        return ok({"runs": rows, "count": len(rows)})

    elif "/data/dashboard" in path:
        _sync_workflow_runs(db)
        leads         = db.select("leads",        params="select=status")
        social_posts  = db.select("social_posts", params="select=status,type")
        blogs         = db.select("blog_posts",   params="select=status")
        pending_appr  = db.select("approval_queue", params="status=eq.pending&select=id,workflow_type")
        workflow_runs = db.select("workflow_runs", params="select=id,workflow_type,status,started_at,completed_at,execution_arn&order=started_at.desc&limit=5")

        return ok({
            "leads": {
                "total":       len(leads),
                "by_status":   _count_by(leads, "status"),
            },
            "social_posts": {
                "total":       len(social_posts),
                "by_status":   _count_by(social_posts, "status"),
                "by_type":     _count_by(social_posts, "type"),
            },
            "blogs": {
                "total":       len(blogs),
                "by_status":   _count_by(blogs, "status"),
            },
            "pending_approvals": len(pending_appr),
            "workflow_runs": workflow_runs,
        })

    return err("Unknown endpoint", 404)


def _count_by(rows: list, field: str) -> dict:
    counts = {}
    for r in rows:
        v = r.get(field, "unknown")
        counts[v] = counts.get(v, 0) + 1
    return counts


def _sync_workflow_runs(db):
    sfn = boto3.client("stepfunctions")
    runs = db.select("workflow_runs", params="status=eq.running&select=id,execution_arn,status,workflow_type,started_at&limit=20")
    for run in runs:
        arn = run.get("execution_arn")
        if not arn:
            continue
        try:
            resp = sfn.describe_execution(executionArn=arn)
        except Exception:
            continue

        status = resp.get("status", "")
        if status == "RUNNING":
            continue

        update = {
            "status": "succeeded" if status == "SUCCEEDED" else "failed" if status == "FAILED" else "stopped" if status == "ABORTED" else "timed_out",
            "completed_at": _to_iso(resp.get("stopDate") or run.get("completed_at")),
        }

        if status == "SUCCEEDED" and resp.get("output"):
            try:
                update["output"] = json.loads(resp["output"])
            except Exception:
                update["output"] = {"raw": resp["output"]}
        elif status in ("FAILED", "ABORTED", "TIMED_OUT"):
            update["error_msg"] = resp.get("cause") or resp.get("error") or status

        db.update("workflow_runs", update, params=f"id=eq.{run['id']}")


def _to_iso(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value
