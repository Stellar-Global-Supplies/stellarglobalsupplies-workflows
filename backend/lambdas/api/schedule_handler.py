"""
Lambda: schedule_handler
CRUD for workflow_schedules table + EventBridge enable/disable.

Routes (all via API Gateway):
  GET    /schedules               - list all schedules
  POST   /schedules               - create a schedule + EventBridge rule
  GET    /schedules/{id}          - get one schedule
  PATCH  /schedules/{id}          - update schedule (recreates EB rule if timing changes)
  DELETE /schedules/{id}          - delete schedule + EventBridge rule
  PATCH  /schedules/{id}/toggle   - enable or disable the EventBridge rule
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
import uuid
import re
import boto3
from shared.supabase_client import get_client
from shared.utils import ok, err, now_iso

# ── EventBridge / Step Functions config ─────────────────────────────────────

SF_PREFIX       = os.environ.get("SF_PREFIX", "stellar-wf-prod-")
EVENTS_ROLE_ARN = os.environ.get("EVENTS_ROLE_ARN", "")
AWS_REGION      = os.environ.get("AWS_REGION", "us-east-1")

# Maps workflow_type key → Step Functions state machine name suffix
SF_NAMES = {
    "lead-generation": "lead-generation",
    "social-product":  "social-product",
    "social-tech":     "social-tech",
    "blog":            "blog-post",
}

VALID_WORKFLOW_TYPES = list(SF_NAMES.keys())


def _sfn_arn(workflow_type: str) -> str:
    account_id = boto3.client("sts").get_caller_identity()["Account"]
    sf_name    = SF_NAMES[workflow_type]
    return f"arn:aws:states:{AWS_REGION}:{account_id}:stateMachine:{SF_PREFIX}{sf_name}"


# ── IST → UTC cron conversion ────────────────────────────────────────────────

def _ist_to_utc_hour_minute(time_str: str):
    """
    Convert HH:MM IST to UTC.
    IST = UTC+5:30, so UTC = IST - 5h30m
    """
    hh, mm = map(int, time_str.split(":"))
    total_minutes = hh * 60 + mm - 330  # subtract 5h30m = 330 minutes
    if total_minutes < 0:
        total_minutes += 24 * 60
    utc_hh = (total_minutes // 60) % 24
    utc_mm = total_minutes % 60
    return utc_hh, utc_mm


def _build_cron(schedule: dict) -> str:
    """
    Build an EventBridge cron() expression from a schedule row.
    All times stored as IST, converted to UTC for EventBridge.
    EventBridge cron format: cron(minutes hours day-of-month month day-of-week year)
    """
    run_time  = schedule.get("run_time", "09:00")
    frequency = schedule.get("frequency", "monthly")
    utc_hh, utc_mm = _ist_to_utc_hour_minute(run_time)

    if frequency == "daily":
        # Every day at UTC time
        return f"cron({utc_mm} {utc_hh} * * ? *)"

    elif frequency == "weekly":
        days_of_week = schedule.get("days_of_week") or [1]  # default Monday
        # EventBridge day-of-week: SUN=1, MON=2, ... SAT=7
        # Our UI: 0=Sun, 1=Mon, ..., 6=Sat → add 1 for EB
        eb_days = ",".join(str(d + 1) for d in sorted(days_of_week))
        return f"cron({utc_mm} {utc_hh} ? * {eb_days} *)"

    else:  # monthly
        day_of_month = schedule.get("day_of_month", 1)
        return f"cron({utc_mm} {utc_hh} {day_of_month} * ? *)"


# ── EventBridge helpers ──────────────────────────────────────────────────────

def _rule_name(schedule_id: str, workflow_type: str) -> str:
    """Deterministic, unique EventBridge rule name."""
    short = schedule_id.replace("-", "")[:12]
    wf    = workflow_type.replace("-", "_")
    return f"{SF_PREFIX}sched-{wf}-{short}"


def _put_eventbridge_rule(schedule: dict, sfn_arn: str) -> str:
    """
    Create or update an EventBridge rule targeting the given Step Functions ARN.
    Returns the rule name.
    """
    events     = boto3.client("events")
    rule_name  = _rule_name(schedule["id"], schedule["workflow_type"])
    cron_expr  = _build_cron(schedule)
    state      = "ENABLED" if schedule.get("enabled", True) else "DISABLED"

    # Build the input that will be passed to Step Functions
    # Mirrors what workflow_trigger.py sends as sf_input
    sf_input = {
        **schedule.get("parameters", {}),
        "workflowRunId": "{{scheduled-run}}",  # will be overridden at runtime
        "scheduledBy":   rule_name,
        "scheduleId":    schedule["id"],
    }

    # Create/update the rule
    events.put_rule(
        Name=rule_name,
        ScheduleExpression=cron_expr,
        State=state,
        Description=f"Stellar Workflows scheduled run: {schedule.get('label', '')}",
    )

    # Set the target to the Step Functions state machine
    events.put_targets(
        Rule=rule_name,
        Targets=[{
            "Id":      "StepFunctionsTarget",
            "Arn":     sfn_arn,
            "RoleArn": EVENTS_ROLE_ARN,
            "Input":   json.dumps(sf_input),
        }],
    )

    return rule_name


def _delete_eventbridge_rule(rule_name: str):
    """Remove targets then delete the EventBridge rule. Safe to call if rule doesn't exist."""
    if not rule_name:
        return
    events = boto3.client("events")
    try:
        events.remove_targets(Rule=rule_name, Ids=["StepFunctionsTarget"])
    except events.exceptions.ResourceNotFoundException:
        pass
    except Exception:
        pass
    try:
        events.delete_rule(Name=rule_name, Force=True)
    except events.exceptions.ResourceNotFoundException:
        pass
    except Exception:
        pass


def _toggle_eventbridge_rule(rule_name: str, enabled: bool):
    """Enable or disable an existing EventBridge rule."""
    if not rule_name:
        return
    events = boto3.client("events")
    try:
        if enabled:
            events.enable_rule(Name=rule_name)
        else:
            events.disable_rule(Name=rule_name)
    except events.exceptions.ResourceNotFoundException:
        pass  # Rule not yet created — nothing to toggle


# ── Request parsing ───────────────────────────────────────────────────────────

def _parse_body(event: dict) -> dict:
    body = event.get("body") or "{}"
    if isinstance(body, str):
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {}
    return body or {}


def _path_id(event: dict) -> str | None:
    """Extract {id} from path like /schedules/{id} or /schedules/{id}/toggle."""
    path = event.get("path") or event.get("rawPath", "")
    m = re.search(r"/schedules/([a-f0-9-]{36})", path)
    return m.group(1) if m else None


def _is_toggle(event: dict) -> bool:
    path = event.get("path") or event.get("rawPath", "")
    return path.endswith("/toggle")


def _http_method(event: dict) -> str:
    return (
        event.get("httpMethod")
        or (event.get("requestContext") or {}).get("http", {}).get("method")
        or "GET"
    ).upper()


# ── Validation ────────────────────────────────────────────────────────────────

def _validate_schedule(body: dict, partial: bool = False) -> str | None:
    """Return error string or None."""
    if not partial:
        if not body.get("workflow_type"):
            return "workflow_type is required"
        if body["workflow_type"] not in VALID_WORKFLOW_TYPES:
            return f"workflow_type must be one of: {VALID_WORKFLOW_TYPES}"
        if not body.get("label", "").strip():
            return "label is required"
        if not body.get("run_time"):
            return "run_time is required (HH:MM IST)"

    freq = body.get("frequency")
    if freq and freq not in ("daily", "weekly", "monthly"):
        return "frequency must be daily, weekly, or monthly"

    dom = body.get("day_of_month")
    if dom is not None and not (1 <= int(dom) <= 28):
        return "day_of_month must be between 1 and 28"

    return None


# ── Handlers ─────────────────────────────────────────────────────────────────

def _list_schedules(db, qs: dict) -> dict:
    params = "order=created_at.desc"
    wf     = qs.get("workflow_type", "")
    if wf:
        params += f"&workflow_type=eq.{wf}"
    rows = db.select("workflow_schedules", params=params)
    return ok({"schedules": rows, "count": len(rows)})


def _get_schedule(db, schedule_id: str) -> dict:
    rows = db.select("workflow_schedules", params=f"id=eq.{schedule_id}&limit=1")
    if not rows:
        return err("Schedule not found", 404)
    return ok({"schedule": rows[0]})


def _create_schedule(db, body: dict) -> dict:
    error = _validate_schedule(body)
    if error:
        return err(error)

    schedule_id = str(uuid.uuid4())
    row = {
        "id":                    schedule_id,
        "workflow_type":         body["workflow_type"],
        "label":                 body["label"].strip(),
        "frequency":             body.get("frequency", "monthly"),
        "day_of_month":          body.get("day_of_month", 1),
        "days_of_week":          body.get("days_of_week", []),
        "run_time":              body.get("run_time", "09:00"),
        "enabled":               body.get("enabled", True),
        "parameters":            body.get("parameters", {}),
        "created_at":            now_iso(),
        "updated_at":            now_iso(),
    }

    # Create EventBridge rule
    try:
        sfn_arn   = _sfn_arn(row["workflow_type"])
        rule_name = _put_eventbridge_rule(row, sfn_arn)
        row["eventbridge_rule_name"] = rule_name
    except Exception as e:
        return err(f"Failed to create EventBridge rule: {str(e)}", 500)

    saved = db.insert("workflow_schedules", row)
    return ok({"schedule": saved, "message": "Schedule created"})


def _update_schedule(db, schedule_id: str, body: dict) -> dict:
    rows = db.select("workflow_schedules", params=f"id=eq.{schedule_id}&limit=1")
    if not rows:
        return err("Schedule not found", 404)
    existing = rows[0]

    error = _validate_schedule(body, partial=True)
    if error:
        return err(error)

    update = {k: v for k, v in body.items() if k not in ("id", "created_at", "eventbridge_rule_name")}
    update["updated_at"] = now_iso()

    # Rebuild the merged schedule to pass to EventBridge
    merged = {**existing, **update, "id": schedule_id}

    # Recreate EventBridge rule (handles timing or label changes)
    try:
        sfn_arn   = _sfn_arn(merged["workflow_type"])
        # Delete old rule if name would change (shouldn't, but safe)
        old_rule  = existing.get("eventbridge_rule_name", "")
        new_rule  = _rule_name(schedule_id, merged["workflow_type"])
        if old_rule and old_rule != new_rule:
            _delete_eventbridge_rule(old_rule)
        rule_name = _put_eventbridge_rule(merged, sfn_arn)
        update["eventbridge_rule_name"] = rule_name
    except Exception as e:
        return err(f"Failed to update EventBridge rule: {str(e)}", 500)

    db.update("workflow_schedules", update, params=f"id=eq.{schedule_id}")
    updated_rows = db.select("workflow_schedules", params=f"id=eq.{schedule_id}&limit=1")
    return ok({"schedule": updated_rows[0] if updated_rows else merged, "message": "Schedule updated"})


def _delete_schedule(db, schedule_id: str) -> dict:
    rows = db.select("workflow_schedules", params=f"id=eq.{schedule_id}&limit=1")
    if not rows:
        return err("Schedule not found", 404)

    rule_name = rows[0].get("eventbridge_rule_name", "")
    _delete_eventbridge_rule(rule_name)

    db.delete("workflow_schedules", params=f"id=eq.{schedule_id}")
    return ok({"message": "Schedule deleted", "id": schedule_id})


def _toggle_schedule(db, schedule_id: str, body: dict) -> dict:
    rows = db.select("workflow_schedules", params=f"id=eq.{schedule_id}&limit=1")
    if not rows:
        return err("Schedule not found", 404)

    enabled   = bool(body.get("enabled", True))
    rule_name = rows[0].get("eventbridge_rule_name", "")

    # Toggle EventBridge rule
    try:
        _toggle_eventbridge_rule(rule_name, enabled)
    except Exception as e:
        return err(f"Failed to toggle EventBridge rule: {str(e)}", 500)

    db.update("workflow_schedules",
              {"enabled": enabled, "updated_at": now_iso()},
              params=f"id=eq.{schedule_id}")

    return ok({"id": schedule_id, "enabled": enabled, "message": f"Schedule {'enabled' if enabled else 'disabled'}"})


# ── Main handler ──────────────────────────────────────────────────────────────

def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return ok({})

    db     = get_client()
    method = _http_method(event)
    qs     = event.get("queryStringParameters") or {}
    body   = _parse_body(event)
    sid    = _path_id(event)
    toggle = _is_toggle(event)

    try:
        if method == "GET" and not sid:
            return _list_schedules(db, qs)

        if method == "GET" and sid:
            return _get_schedule(db, sid)

        if method == "POST" and not sid:
            return _create_schedule(db, body)

        if method == "PATCH" and sid and toggle:
            return _toggle_schedule(db, sid, body)

        if method == "PATCH" and sid and not toggle:
            return _update_schedule(db, sid, body)

        if method == "DELETE" and sid:
            return _delete_schedule(db, sid)

        return err("Unknown route", 404)

    except Exception as e:
        print(f"schedule_handler error: {e}")
        return err(f"Internal error: {str(e)}", 500)