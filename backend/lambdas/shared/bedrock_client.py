import boto3
import json
import base64
import os
from typing import Optional


_bedrock = None
_bedrock_runtime = None


def get_bedrock_runtime():
    global _bedrock_runtime
    if _bedrock_runtime is None:
        _bedrock_runtime = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    return _bedrock_runtime


def generate_text(prompt: str, system: str = "", max_tokens: int = 2000) -> str:
    """Generate text using Amazon Nova via Bedrock."""
    client = get_bedrock_runtime()
    model_id = os.environ.get("BEDROCK_TEXT_MODEL", "amazon.nova-lite-v1:0")

    messages = [{"role": "user", "content": [{"text": prompt}]}]

    body = {
        "messages": messages,
        "inferenceConfig": {
            "maxTokens": max_tokens,
            "temperature": 0.7,
            "topP": 0.9,
        },
    }
    if system:
        body["system"] = [{"text": system}]

    response = client.invoke_model(
        modelId=model_id,
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )
    result = json.loads(response["body"].read())
    return result["output"]["message"]["content"][0]["text"]


def generate_json(prompt: str, system: str = "", max_tokens: int = 2000) -> dict:
    """Generate structured JSON output from Nova."""
    sys_prompt = (system or "") + "\n\nYou must respond ONLY with valid JSON. No markdown, no explanation."
    text = generate_text(prompt, system=sys_prompt, max_tokens=max_tokens)
    # Strip markdown fences if model adds them
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text.strip())


def generate_image(prompt: str, width: int = 1024, height: int = 1024) -> bytes:
    """Generate image using Amazon Nova Canvas via Bedrock."""
    client = get_bedrock_runtime()
    model_id = os.environ.get("BEDROCK_IMAGE_MODEL", "amazon.nova-canvas-v1:0")

    body = {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {"text": prompt},
        "imageGenerationConfig": {
            "numberOfImages": 1,
            "width": width,
            "height": height,
            "quality": "standard",
            "cfgScale": 8.0,
        },
    }

    try:
        response = client.invoke_model(
            modelId=model_id,
            body=json.dumps(body),
            contentType="application/json",
            accept="application/json",
        )
    except Exception as exc:
        message = str(exc)
        # If Nova Canvas is unavailable in the region/account, fall back to Titan Image Generator.
        if "Legacy" in message or "Access denied" in message or "ResourceNotFoundException" in message:
            fallback_model = os.environ.get("BEDROCK_IMAGE_MODEL_FALLBACK", "amazon.titan-image-generator-v2:0")
            fallback_body = {
                "taskType": "TEXT_IMAGE",
                "textToImageParams": {"text": prompt},
                "imageGenerationConfig": {
                    "numberOfImages": 1,
                    "width": width,
                    "height": height,
                    "quality": "standard",
                    "cfgScale": 8.0,
                },
            }
            response = client.invoke_model(
                modelId=fallback_model,
                body=json.dumps(fallback_body),
                contentType="application/json",
                accept="application/json",
            )
        else:
            raise
    result = json.loads(response["body"].read())
    image_b64 = result.get("images", [None])[0] or result.get("artifacts", [{}])[0].get("base64")
    return base64.b64decode(image_b64)
