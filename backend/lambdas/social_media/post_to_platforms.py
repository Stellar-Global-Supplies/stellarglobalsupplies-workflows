"""
Lambda: post_to_platforms
Posts approved content to Facebook, Instagram (auto) and marks LinkedIn for manual posting.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
import urllib.request
import urllib.parse
from shared.supabase_client import get_client
from shared.utils import get_ssm, now_iso, read_json_from_s3


def post_facebook(page_id: str, access_token: str, message: str, image_url: str) -> dict:
    """Post to Facebook page with image."""
    if image_url:
        # Post with photo
        url  = f"https://graph.facebook.com/v18.0/{page_id}/photos"
        body = urllib.parse.urlencode({
            "url":          image_url,
            "caption":      message,
            "access_token": access_token,
        }).encode()
    else:
        url  = f"https://graph.facebook.com/v18.0/{page_id}/feed"
        body = urllib.parse.urlencode({
            "message":      message,
            "access_token": access_token,
        }).encode()

    req = urllib.request.Request(url, data=body, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return {"success": True, "result": json.loads(resp.read())}
    except urllib.error.HTTPError as e:
        return {"success": False, "error": e.read().decode()}


def post_instagram(ig_account_id: str, access_token: str, caption: str, image_url: str) -> dict:
    """Post to Instagram via Graph API (requires image URL)."""
    if not image_url:
        return {"success": False, "error": "Instagram requires an image"}

    base = "https://graph.facebook.com/v18.0"

    # Step 1: Create media container
    create_url  = f"{base}/{ig_account_id}/media"
    create_data = urllib.parse.urlencode({
        "image_url":    image_url,
        "caption":      caption,
        "access_token": access_token,
    }).encode()
    req = urllib.request.Request(create_url, data=create_data, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            container = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"success": False, "error": e.read().decode()}

    container_id = container.get("id")
    if not container_id:
        return {"success": False, "error": "Failed to create media container"}

    # Step 2: Publish
    publish_url  = f"{base}/{ig_account_id}/media_publish"
    publish_data = urllib.parse.urlencode({
        "creation_id":  container_id,
        "access_token": access_token,
    }).encode()
    req = urllib.request.Request(publish_url, data=publish_data, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return {"success": True, "result": json.loads(resp.read())}
    except urllib.error.HTTPError as e:
        return {"success": False, "error": e.read().decode()}


def handler(event, context):
    post      = event["post"]
    post_id   = event["postId"]
    if post.get("content_s3_key"):
        post = {**post, **read_json_from_s3(post["content_s3_key"])}
    platforms = post.get("platforms", {"facebook": True, "instagram": True, "linkedin": True})
    image_url = post.get("image_url", "")

    results = {}

    # Facebook
    if platforms.get("facebook"):
        fb_page_id = get_ssm(os.environ["FB_PAGE_ID_PARAM"])
        fb_token   = get_ssm(os.environ["FB_ACCESS_TOKEN_PARAM"])
        results["facebook"] = post_facebook(
            fb_page_id, fb_token,
            post.get("facebook", post.get("content", "")), image_url
        )

    # Instagram
    if platforms.get("instagram"):
        ig_id    = get_ssm(os.environ["IG_ACCOUNT_ID_PARAM"])
        ig_token = get_ssm(os.environ["IG_ACCESS_TOKEN_PARAM"])
        results["instagram"] = post_instagram(
            ig_id, ig_token,
            post.get("instagram", post.get("content", "")), image_url
        )

    # LinkedIn - manual only, just mark it
    if platforms.get("linkedin"):
        results["linkedin"] = {
            "success": True,
            "manual": True,
            "note": "LinkedIn post queued for manual posting",
            "content": post.get("linkedin", post.get("content", "")),
        }

    success_count = sum(1 for r in results.values() if r.get("success"))
    total_count   = len(results)

    if total_count == 0:
        overall_status = "posted"          # nothing was requested → treat as done
    elif success_count == total_count:
        overall_status = "posted"
    elif success_count > 0:
        overall_status = "partial"
    else:
        overall_status = "failed"

    db  = get_client()
    now = now_iso()
    db.update("social_posts", {
        "status":       overall_status,
        "post_results": results,
        "posted_at":    now,
    }, params=f"id=eq.{post_id}")

    return {
        **event,
        "postResults":   results,
        "overallStatus": overall_status,
    }