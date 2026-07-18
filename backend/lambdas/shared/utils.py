import json
import re
import boto3
import os
import hashlib
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Dict


def response(status: int, body: Any) -> Dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        },
        "body": json.dumps(body, default=str),
    }


def ok(body: Any) -> Dict:
    return response(200, body)


def err(msg: str, status: int = 400) -> Dict:
    return response(status, {"error": msg})


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_-]+", "-", text)
    text = re.sub(r"^-+|-+$", "", text)
    return text[:80]


def content_hash(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def upload_image_to_s3(image_bytes: bytes, key: str, content_type: str = "image/png") -> str:
    """Upload image to S3 and return CloudFront URL."""
    s3 = boto3.client("s3")
    bucket = os.environ["ASSETS_BUCKET"]
    s3.put_object(Bucket=bucket, Key=key, Body=image_bytes, ContentType=content_type)
    cloudfront_url = os.environ.get("ASSETS_CLOUDFRONT_URL", "").rstrip("/")
    return f"{cloudfront_url}/{key}"


def get_ssm(name: str) -> str:
    """Fetch SecureString from SSM Parameter Store."""
    ssm = boto3.client("ssm")
    resp = ssm.get_parameter(Name=name, WithDecryption=True)
    return resp["Parameter"]["Value"]


def send_task_success(task_token: str, output: Dict):
    sfn = boto3.client("stepfunctions")
    sfn.send_task_success(taskToken=task_token, output=json.dumps(output))


def send_task_failure(task_token: str, error: str, cause: str):
    sfn = boto3.client("stepfunctions")
    sfn.send_task_failure(taskToken=task_token, error=error, cause=cause)
