"""
Lambda: post_to_platforms
Posts approved content to Facebook and Instagram via Graph API.
LinkedIn: sends a rich HTML email with the post content + image
          to LINKEDIN_NOTIFY_EMAILS so the team can post manually.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
import base64
import urllib.request
import urllib.parse
from shared.supabase_client import get_client
from shared.utils import get_ssm, now_iso, read_json_from_s3


# ── Facebook ──────────────────────────────────────────────────────────────────

def post_facebook(page_id: str, access_token: str, message: str, image_url: str) -> dict:
    if image_url:
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


# ── Instagram ─────────────────────────────────────────────────────────────────

def post_instagram(ig_account_id: str, access_token: str, caption: str, image_url: str) -> dict:
    if not image_url:
        return {"success": False, "error": "Instagram requires an image"}

    base = "https://graph.facebook.com/v18.0"

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


# ── LinkedIn (email notification) ─────────────────────────────────────────────

def _get_gmail_access_token() -> str:
    client_id     = get_ssm(os.environ["GMAIL_CLIENT_ID_PARAM"])
    client_secret = get_ssm(os.environ["GMAIL_CLIENT_SECRET_PARAM"])
    refresh_token = get_ssm(os.environ["GMAIL_REFRESH_TOKEN_PARAM"])

    data = urllib.parse.urlencode({
        "client_id":     client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type":    "refresh_token",
    }).encode()

    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["access_token"]


def _build_linkedin_email_html(post: dict, linkedin_content: str, image_url: str, title: str) -> str:
    """Build a rich HTML email body for the LinkedIn post notification."""
    image_block = ""
    if image_url:
        image_block = f"""
        <div style="margin: 24px 0; text-align: center;">
          <img src="{image_url}"
               alt="Post Image"
               style="max-width: 560px; width: 100%; border-radius: 10px;
                      border: 1px solid #e2e8f0; display: block; margin: 0 auto;" />
          <p style="font-size: 12px; color: #94a3b8; margin-top: 8px;">
            Image to attach when posting on LinkedIn
          </p>
        </div>"""

    # Convert newlines to <br> for HTML rendering
    content_html = linkedin_content.replace("\n\n", "</p><p style='margin: 16px 0; color: #1e293b; line-height: 1.8;'>")
    content_html = content_html.replace("\n", "<br>")
    content_html = f"<p style='margin: 16px 0; color: #1e293b; line-height: 1.8;'>{content_html}</p>"

    return f"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
  <div style="max-width: 620px; margin: 32px auto; background: #fff; border-radius: 16px;
              border: 1px solid #e2e8f0; overflow: hidden;">

    <!-- Header -->
    <div style="background: #0A66C2; padding: 28px 32px;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/>
          <rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>
        </svg>
        <div>
          <h1 style="margin: 0; color: white; font-size: 18px; font-weight: 700;">LinkedIn Post Ready</h1>
          <p style="margin: 2px 0 0; color: #bfdbfe; font-size: 13px;">Stellar Global Supplies · Action Required</p>
        </div>
      </div>
    </div>

    <!-- Body -->
    <div style="padding: 32px;">

      <p style="margin: 0 0 8px; font-size: 13px; color: #64748b; text-transform: uppercase;
                letter-spacing: 0.05em; font-weight: 600;">Post Title</p>
      <h2 style="margin: 0 0 24px; font-size: 20px; color: #0f172a; font-weight: 700;">{title}</h2>

      <!-- Instructions -->
      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px;
                  padding: 16px 20px; margin-bottom: 28px;">
        <p style="margin: 0; font-size: 14px; color: #1d4ed8; font-weight: 600;">
          How to post on LinkedIn
        </p>
        <ol style="margin: 8px 0 0; padding-left: 20px; font-size: 13px; color: #1e40af; line-height: 1.8;">
          <li>Copy the post content below</li>
          <li>Go to <strong>linkedin.com/company/stellar-global-supplies</strong></li>
          <li>Click <strong>Start a post</strong></li>
          <li>Paste the content</li>
          <li>Download and attach the image below</li>
          <li>Click <strong>Post</strong></li>
        </ol>
      </div>

      <!-- Image -->
      {image_block}

      <!-- Post Content -->
      <div style="margin-bottom: 8px;">
        <p style="margin: 0 0 12px; font-size: 13px; color: #64748b; text-transform: uppercase;
                  letter-spacing: 0.05em; font-weight: 600;">LinkedIn Post Content</p>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px;
                    padding: 24px; font-size: 15px; line-height: 1.8; color: #1e293b;">
          {content_html}
        </div>
      </div>

      <!-- Copy hint -->
      <p style="margin: 12px 0 0; font-size: 12px; color: #94a3b8; text-align: center;">
        Select all text in the box above and copy it exactly as shown
      </p>

    </div>

    <!-- Footer -->
    <div style="background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 32px;
                text-align: center;">
      <p style="margin: 0; font-size: 12px; color: #94a3b8;">
        Stellar Global Supplies · Automated Workflow System<br>
        This email was generated and sent automatically when the post was approved.
      </p>
    </div>
  </div>
</body>
</html>"""


def _build_mime_multipart(to: str, subject: str, html_body: str, sender: str) -> str:
    """Build an RFC2822 MIME message with HTML body."""
    mime = (
        f"From: {sender}\r\n"
        f"To: {to}\r\n"
        f"Subject: {subject}\r\n"
        f"MIME-Version: 1.0\r\n"
        f"Content-Type: text/html; charset=utf-8\r\n\r\n"
        f"{html_body}"
    )
    return base64.urlsafe_b64encode(mime.encode()).decode()


def _send_gmail(access_token: str, raw: str) -> dict:
    payload = json.dumps({"raw": raw}).encode()
    req = urllib.request.Request(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        data=payload,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type":  "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def send_linkedin_email(post: dict, linkedin_content: str, image_url: str, title: str) -> dict:
    """
    Send the LinkedIn post content + image to the configured notify emails.
    Uses the same Gmail OAuth credentials as lead email sending.
    """
    notify_emails_raw = os.environ.get("LINKEDIN_NOTIFY_EMAILS", "")
    if not notify_emails_raw.strip():
        return {
            "success": False,
            "manual":  True,
            "error":   "LINKEDIN_NOTIFY_EMAILS not configured",
            "content": linkedin_content,
        }

    notify_emails = [e.strip() for e in notify_emails_raw.split(",") if e.strip()]
    sender        = os.environ.get("SENDER_EMAIL", "sales@stellarglobalsupplies.com")
    subject       = f"[LinkedIn] Ready to Post: {title}"
    html_body     = _build_linkedin_email_html(post, linkedin_content, image_url, title)

    try:
        access_token = _get_gmail_access_token()
    except Exception as e:
        return {
            "success": False,
            "manual":  True,
            "error":   f"Gmail auth failed: {str(e)}",
            "content": linkedin_content,
        }

    sent_to = []
    errors  = []
    for email in notify_emails:
        try:
            raw = _build_mime_multipart(email, subject, html_body, sender)
            _send_gmail(access_token, raw)
            sent_to.append(email)
            print(f"[post_to_platforms] LinkedIn email sent to {email}")
        except Exception as e:
            errors.append(f"{email}: {str(e)}")
            print(f"[post_to_platforms] LinkedIn email failed for {email}: {e}")

    if sent_to:
        return {
            "success":  True,
            "manual":   True,
            "note":     f"LinkedIn post emailed to {', '.join(sent_to)} for manual posting",
            "sent_to":  sent_to,
            "errors":   errors,
            "content":  linkedin_content,
        }
    else:
        return {
            "success": False,
            "manual":  True,
            "error":   f"All LinkedIn emails failed: {errors}",
            "content": linkedin_content,
        }


# ── Main handler ──────────────────────────────────────────────────────────────

def handler(event, context):
    post      = event["post"]
    post_id   = event["postId"]
    if post.get("content_s3_key"):
        post = {**post, **read_json_from_s3(post["content_s3_key"])}

    platforms = post.get("platforms", {"facebook": True, "instagram": True, "linkedin": True})
    image_url = post.get("image_url", "")
    title     = post.get("title", "Stellar Global Supplies Post")

    results = {}

    # ── Facebook ─────────────────────────────────────────────
    if platforms.get("facebook"):
        print("[post_to_platforms] posting to Facebook")
        fb_page_id = get_ssm(os.environ["FB_PAGE_ID_PARAM"])
        fb_token   = get_ssm(os.environ["FB_ACCESS_TOKEN_PARAM"])
        results["facebook"] = post_facebook(
            fb_page_id, fb_token,
            post.get("facebook", post.get("content", "")), image_url
        )
        print(f"[post_to_platforms] Facebook result: success={results['facebook'].get('success')}")

    # ── Instagram ─────────────────────────────────────────────
    if platforms.get("instagram"):
        print("[post_to_platforms] posting to Instagram")
        ig_id    = get_ssm(os.environ["IG_ACCOUNT_ID_PARAM"])
        ig_token = get_ssm(os.environ["IG_ACCESS_TOKEN_PARAM"])
        results["instagram"] = post_instagram(
            ig_id, ig_token,
            post.get("instagram", post.get("content", "")), image_url
        )
        print(f"[post_to_platforms] Instagram result: success={results['instagram'].get('success')}")

    # ── LinkedIn (email notification) ─────────────────────────
    if platforms.get("linkedin"):
        print("[post_to_platforms] sending LinkedIn email notification")
        linkedin_content = post.get("linkedin", post.get("content", ""))
        results["linkedin"] = send_linkedin_email(post, linkedin_content, image_url, title)
        print(f"[post_to_platforms] LinkedIn email result: success={results['linkedin'].get('success')} sent_to={results['linkedin'].get('sent_to')}")

    # ── Overall status ────────────────────────────────────────
    # LinkedIn manual=True counts as success only if the email actually sent.
    # A manual:True + success:False (e.g. email failed) is treated as a real failure.
    success_count = sum(1 for r in results.values() if r.get("success"))
    total_count   = len(results)

    # Status vocabulary must match social_posts_status_check constraint:
    # pending_approval | approved_manual | publishing | published |
    # rejected | publish_failed | partial | failed
    if total_count == 0:
        overall_status = "published"
    elif success_count == total_count:
        overall_status = "published"
    elif success_count > 0:
        overall_status = "partial"
    else:
        overall_status = "publish_failed"

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