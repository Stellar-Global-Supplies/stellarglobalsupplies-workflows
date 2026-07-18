"""
Lambda: workflow_trigger
HTTP handler - triggers a Step Functions execution for any workflow type.
POST /workflows/{type}
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
import uuid
import boto3
from shared.supabase_client import get_client
from shared.utils import ok, err, now_iso

SF_PREFIX = os.environ.get("SF_PREFIX", "stellar-wf-prod-")

STATE_MACHINES = {
    "lead-generation": f"arn:aws:states:{os.environ.get('AWS_REGION', 'us-east-1')}:{boto3.client('sts').get_caller_identity()['Account']}:stateMachine:{SF_PREFIX}lead-generation",
    "lead-email-existing": f"arn:aws:states:{os.environ.get('AWS_REGION', 'us-east-1')}:{boto3.client('sts').get_caller_identity()['Account']}:stateMachine:{SF_PREFIX}lead-email-existing",
    "social-product":  f"arn:aws:states:{os.environ.get('AWS_REGION', 'us-east-1')}:{boto3.client('sts').get_caller_identity()['Account']}:stateMachine:{SF_PREFIX}social-product",
    "social-tech":     f"arn:aws:states:{os.environ.get('AWS_REGION', 'us-east-1')}:{boto3.client('sts').get_caller_identity()['Account']}:stateMachine:{SF_PREFIX}social-tech",
    "blog":            f"arn:aws:states:{os.environ.get('AWS_REGION', 'us-east-1')}:{boto3.client('sts').get_caller_identity()['Account']}:stateMachine:{SF_PREFIX}blog-post",
}


def handler(event, context):
    if event.get("httpMethod") == "OPTIONS":
        return ok({})

    path_params = event.get("pathParameters") or {}
    wf_type     = path_params.get("type", "")

    if wf_type not in STATE_MACHINES:
        return err(f"Unknown workflow type: {wf_type}. Valid: {list(STATE_MACHINES.keys())}")

    sm_arn = STATE_MACHINES[wf_type]
    if not sm_arn:
        return err(f"State machine ARN not configured for: {wf_type}", 500)

    body = {}
    if event.get("body"):
        try:
            body = json.loads(event["body"])
        except json.JSONDecodeError:
            return err("Invalid JSON body")

    run_id = str(uuid.uuid4())
    sfn    = boto3.client("stepfunctions")

    sf_input = {**body, "workflowRunId": run_id}

    # Log workflow run
    db  = get_client()
    run = db.insert("workflow_runs", {
        "id":            run_id,
        "workflow_type": wf_type.replace("-", "_"),
        "status":        "running",
        "input":         sf_input,
        "started_at":    now_iso(),
    })

    resp = sfn.start_execution(
        stateMachineArn=sm_arn,
        name=f"{wf_type}-{run_id[:8]}",
        input=json.dumps(sf_input),
    )

    db.update("workflow_runs", {
        "execution_arn": resp["executionArn"],
    }, params=f"id=eq.{run_id}")

    return ok({
        "workflowRunId": run_id,
        "executionArn":  resp["executionArn"],
        "status":        "started",
    })
