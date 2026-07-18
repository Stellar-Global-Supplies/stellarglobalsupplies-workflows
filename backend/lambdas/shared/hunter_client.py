"""
Hunter.io API client - credit-aware (50 searches/month limit).
Strategy:
  1. Check remaining credits before every search
  2. Only consume a credit when finding a genuinely NEW domain (not in leads table)
  3. Fall back to AI-generated free email when credits are exhausted or < MIN_RESERVE
  4. Log every credit consumption to Supabase for auditing
"""
import os
import json
import urllib.request
import urllib.parse
import urllib.error
from typing import Optional, Dict, Any

MIN_RESERVE = 3          # Keep 3 credits as buffer
MONTHLY_CAP = 50         # Hunter.io free plan


def _get_key() -> str:
    key = os.environ.get("HUNTER_API_KEY", "")
    if not key:
        from .utils import get_ssm
        key = get_ssm(os.environ["HUNTER_API_KEY_PARAM"])
    return key


def get_account_info() -> Dict[str, Any]:
    """Returns current plan usage: requests used, requests available."""
    key = _get_key()
    url = f"https://api.hunter.io/v2/account?api_key={urllib.parse.quote(key)}"
    req = urllib.request.Request(url, headers={"User-Agent": "StellarWorkflows/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        meta = data.get("data", {})
        calls = meta.get("calls", {})
        return {
            "used":      calls.get("used", 0),
            "available": calls.get("available", MONTHLY_CAP),
            "plan_name": meta.get("plan_name", "free"),
        }
    except Exception as e:
        return {"used": 0, "available": 0, "error": str(e)}


def credits_remaining() -> int:
    info = get_account_info()
    return info.get("available", 0)


def domain_search(domain: str, limit: int = 5) -> Optional[Dict]:
    """
    Search Hunter.io for email addresses at a domain.
    Returns first verified/generic email found, or None.
    Does NOT consume a credit if Hunter returns cached/empty results.
    """
    key   = _get_key()
    clean = domain.replace("https://", "").replace("http://", "").split("/")[0].strip()
    url   = (
        f"https://api.hunter.io/v2/domain-search"
        f"?domain={urllib.parse.quote(clean)}"
        f"&limit={limit}"
        f"&type=generic"
        f"&api_key={urllib.parse.quote(key)}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "StellarWorkflows/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        raise RuntimeError(f"Hunter domain-search failed {e.code}: {err}")

    results = data.get("data", {})
    emails  = results.get("emails", [])
    if not emails:
        return None

    # Prefer: verified > generic > personal
    for confidence_threshold in [80, 50, 0]:
        for em in emails:
            if em.get("confidence", 0) >= confidence_threshold:
                return {
                    "email":       em.get("value", ""),
                    "first_name":  em.get("first_name", ""),
                    "last_name":   em.get("last_name", ""),
                    "position":    em.get("position", ""),
                    "confidence":  em.get("confidence", 0),
                    "type":        em.get("type", "generic"),
                    "domain":      clean,
                    "source":      "hunter.io",
                    "organization": results.get("organization", ""),
                    "description": results.get("description", ""),
                    "country":     results.get("country", ""),
                    "phone":       results.get("phone_number", ""),
                }
    return None


def find_email_for_lead(company_website: str, company_name: str, db_client) -> Dict:
    """
    Main entry point. Returns dict with email info + whether Hunter was used.
    Checks credits, deduplicates against DB, falls back to AI if needed.
    """
    remaining = credits_remaining()

    if remaining <= MIN_RESERVE:
        return {
            "hunter_used":   False,
            "hunter_skipped_reason": f"credits_low ({remaining} remaining, reserve={MIN_RESERVE})",
            "email":         None,
        }

    # Check if this domain is already in our leads table
    if company_website:
        import urllib.parse as up
        domain = company_website.replace("https://", "").replace("http://", "").split("/")[0]
        enc    = up.quote(f"%{domain}%")
        existing = db_client.select("leads", params=f"website=ilike.{enc}&select=id&limit=1")
        if existing:
            return {
                "hunter_used":   False,
                "hunter_skipped_reason": "domain_already_in_db",
                "email":         None,
            }

    # Consume a credit
    try:
        result = domain_search(company_website or company_name)
    except Exception as e:
        return {
            "hunter_used":   False,
            "hunter_skipped_reason": f"api_error: {e}",
            "email":         None,
        }

    if not result:
        return {
            "hunter_used":   True,
            "hunter_skipped_reason": "no_emails_found",
            "email":         None,
        }

    # Log credit usage to Supabase
    try:
        db_client.insert("hunter_usage_log", {
            "domain":          result.get("domain", ""),
            "email_found":     result.get("email", ""),
            "credits_before":  remaining,
        })
    except Exception:
        pass  # Non-fatal - table may not exist yet

    return {
        "hunter_used":  True,
        "email":        result["email"],
        "contact_name": f"{result.get('first_name','')} {result.get('last_name','')}".strip(),
        "phone":        result.get("phone", ""),
        "description":  result.get("description", ""),
        "country":      result.get("country", ""),
        "confidence":   result.get("confidence", 0),
        "source":       "hunter.io",
    }
