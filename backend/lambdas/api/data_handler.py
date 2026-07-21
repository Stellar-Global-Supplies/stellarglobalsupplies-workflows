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
import re
import urllib.parse
from shared.supabase_client import get_client
from shared.utils import ok, err, read_json_from_s3
from social_media.get_orders import handler as get_orders_handler
from social_media.post_to_platforms import handler as post_to_platforms_handler
from blog_post.create_github_pr import handler as create_github_pr_handler


def _http_method(event):
    return (
        event.get("httpMethod")
        or (event.get("requestContext") or {}).get("http", {}).get("method")
        or "GET"
    ).upper()


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return ok({})

    path    = event.get("path") or event.get("rawPath", "")
    qs      = event.get("queryStringParameters") or {}
    db      = get_client()
    method  = _http_method(event)
    try:
        limit  = int(qs.get("limit", 50))
        offset = int(qs.get("offset", 0))
    except (TypeError, ValueError):
        limit  = 50
        offset = 0
    status  = qs.get("status", "")

    def with_filters(base_params: str, table_status: str = "") -> str:
        params = base_params
        if table_status:
            params += f"&status=eq.{table_status}"
        params += f"&limit={limit}&offset={offset}"
        return params

    if method == "POST":
        return _handle_action(path, db)

    if "/data/content" in path:
        key = qs.get("key", "")
        if not key:
            return err("Missing content key")
        return ok({"content": read_json_from_s3(key)})

    if "/data/orders/lookup" in path:
        order = get_orders_handler({
            "order_id": qs.get("order_id", ""),
            "product_type": qs.get("product_type", ""),
            "limit": 1,
        }, None)
        return ok(order)

    if "/data/orders" in path:
        # Build query parameters for orders table
        params = "order=created_at.desc"
        
        # Support filtering by payment_status
        # Check if value already contains a PostgREST operator (eq., neq., gt., lt., etc.)
        payment_status = qs.get("payment_status", "")
        if payment_status:
            if any(payment_status.startswith(op) for op in ('eq.', 'neq.', 'gt.', 'gte.', 'lt.', 'lte.', 'like.', 'ilike.')):
                # Value already has operator, split and encode the value part
                operator = payment_status[:payment_status.index('.')+1]
                value = urllib.parse.quote(payment_status[payment_status.index('.')+1:], safe='')
                params += f"&payment_status={operator}{value}"
            else:
                # No operator, add eq. and URL-encode the value
                params += f"&payment_status=eq.{urllib.parse.quote(payment_status, safe='')}"
        
        # Support filtering by status (order status)
        order_status = qs.get("status", "")
        if order_status:
            if any(order_status.startswith(op) for op in ('eq.', 'neq.', 'gt.', 'gte.', 'lt.', 'lte.', 'like.', 'ilike.')):
                # Value already has operator, split and encode the value part
                operator = order_status[:order_status.index('.')+1]
                value = urllib.parse.quote(order_status[order_status.index('.')+1:], safe='')
                params += f"&status={operator}{value}"
            else:
                # No operator, add eq. and URL-encode the value
                params += f"&status=eq.{urllib.parse.quote(order_status, safe='')}"
        
        # Add limit and offset
        params += f"&limit={limit}&offset={offset}"
        
        rows = db.select("orders", params=params)
        return ok({"orders": rows, "count": len(rows)})

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
        _sync_workflow_runs(db)
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
        workflow_runs = db.select("workflow_runs", params="select=id,workflow_type,status,started_at,completed_at,execution_arn,cost_usd,input_tokens,output_tokens,image_count&order=started_at.desc&limit=5")
        cost_runs     = db.select("workflow_runs", params="select=workflow_type,cost_usd,input_tokens,output_tokens,image_count&status=eq.succeeded&order=started_at.desc&limit=200")

        # Aggregate cost by workflow type
        cost_by_type = {}
        total_cost   = 0.0
        for r in cost_runs:
            wt   = r.get("workflow_type", "unknown")
            cost = float(r.get("cost_usd") or 0)
            cost_by_type[wt] = round(cost_by_type.get(wt, 0) + cost, 6)
            total_cost += cost

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
            "workflow_runs":     workflow_runs,
            "cost": {
                "total_usd":    round(total_cost, 6),
                "by_type":      cost_by_type,
            },
        })

    return err("Unknown endpoint", 404)


def _handle_action(path: str, db):
    social_match = re.search(r"/data/social-posts/([^/]+)/repost$", path)
    if social_match:
        post_id = social_match.group(1)
        rows = db.select("social_posts", params=f"id=eq.{post_id}&limit=1")
        if not rows:
            return err("Social post not found", 404)
        # Mark as publishing before invoking so any DB write from post_to_platforms
        # is an update from a valid status, not a constraint-violating cold write
        try:
            db.update("social_posts", {"status": "publishing"}, params=f"id=eq.{post_id}")
        except Exception as e:
            print(f"[repost] could not set publishing status: {e}")
        result = post_to_platforms_handler({"postId": post_id, "post": rows[0]}, None)
        return ok({"message": "Social post reposted", "result": result})

    # POST /data/social-posts/{id}/publish → creates Gate 2 approval entry
    publish_match = re.search(r"/data/social-posts/([^/]+)/publish$", path)
    if publish_match:
        import uuid as _uuid
        post_id = publish_match.group(1)
        rows = db.select("social_posts", params=f"id=eq.{post_id}&limit=1")
        if not rows:
            return err("Social post not found", 404)
        post = rows[0]
        if post["status"] != "approved_manual":
            return err(f"Post must be in 'approved_manual' status to publish. Current: '{post['status']}'", 400)
        platforms    = post.get("platforms") or {}
        active       = [p for p, v in platforms.items() if v]
        platform_str = ", ".join(active) if active else post.get("platform", "")
        row = {
            "workflow_type": f"social_{post.get('type','product')}",
            "reference_id":  post_id,
            "task_token":    f"direct-publish-{_uuid.uuid4()}",
            "payload": {
                "post":         post,
                "postId":       post_id,
                "approvalGate": "publish",
            },
            "preview_html": f"""
<div style="font-family:Arial,sans-serif;max-width:600px">
  <h2>Publish Approval</h2>
  <p><strong>Title:</strong> {post.get('title','')}</p>
  <p><strong>Type:</strong> {post.get('type','')}</p>
  <p><strong>Platforms:</strong> {platform_str}</p>
  {"<img src='" + post.get('image_url','') + "' style='max-width:100%;margin:8px 0'/>" if post.get('image_url') else ''}
  <p style="white-space:pre-wrap">{(post.get('caption') or post.get('content',''))[:500]}</p>
</div>""",
            "status": "pending",
        }
        saved = db.insert("approval_queue", row)
        db.update("social_posts", {"status": "publishing"}, params=f"id=eq.{post_id}")
        return ok({"message": "Publish approval queued", "approvalId": saved["id"]})

    blog_match = re.search(r"/data/blog-posts/([^/]+)/republish$", path)
    if blog_match:
        blog_id = blog_match.group(1)
        rows = db.select("blog_posts", params=f"id=eq.{blog_id}&limit=1")
        if not rows:
            return err("Blog post not found", 404)
        blog = rows[0]
        if blog.get("slug"):
            blog = {**blog, "slug": f"{blog['slug']}-repost-{blog_id[:8]}"}
        result = create_github_pr_handler({"blogId": blog_id, "blog": blog}, None)
        return ok({"message": "Blog PR created again", "result": result})

    return err("Unknown action", 404)


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