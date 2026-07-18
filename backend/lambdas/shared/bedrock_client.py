"""
Bedrock client — Nova Pro for text, multi-model fallback for images.

Image fallback order (auto, no config needed):
  1. amazon.nova-canvas-v1:0
  2. amazon.titan-image-generator-v2:0
  3. stability.stable-diffusion-xl-v1:0
Returns None if ALL fail — callers must handle None gracefully.
"""
import boto3
import json
import base64
import os
import logging
from typing import Optional

log = logging.getLogger(__name__)

_bedrock_runtime = None


def get_bedrock_runtime():
    global _bedrock_runtime
    if _bedrock_runtime is None:
        _bedrock_runtime = boto3.client(
            "bedrock-runtime",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
    return _bedrock_runtime


# ─── TEXT — Amazon Nova Pro ────────────────────────────────
def generate_text(prompt: str, system: str = "", max_tokens: int = 2000) -> str:
    client   = get_bedrock_runtime()
    model_id = os.environ.get("BEDROCK_TEXT_MODEL", "amazon.nova-pro-v1:0")
    body = {
        "messages": [{"role": "user", "content": [{"text": prompt}]}],
        "inferenceConfig": {"maxTokens": max_tokens, "temperature": 0.7, "topP": 0.9},
    }
    if system:
        body["system"] = [{"text": system}]
    resp   = client.invoke_model(modelId=model_id, body=json.dumps(body),
                                 contentType="application/json", accept="application/json")
    result = json.loads(resp["body"].read())
    return result["output"]["message"]["content"][0]["text"]


def generate_json(prompt: str, system: str = "", max_tokens: int = 2000) -> dict:
    sys_p = (system or "") + "\n\nRespond ONLY with valid JSON. No markdown fences, no commentary."
    text  = generate_text(prompt, system=sys_p, max_tokens=max_tokens).strip()
    if text.startswith("```"):
        parts = text.split("```")
        text  = parts[1][4:] if parts[1].startswith("json") else parts[1]
    return json.loads(text.strip())


# ─── IMAGE — per-model builders ───────────────────────────
def _nova_canvas(client, prompt: str, width: int, height: int) -> bytes:
    body = {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {"text": prompt[:512]},
        "imageGenerationConfig": {
            "numberOfImages": 1, "width": width,
            "height": height, "quality": "standard", "cfgScale": 8.0,
        },
    }
    r = client.invoke_model(modelId="amazon.nova-canvas-v1:0", body=json.dumps(body),
                            contentType="application/json", accept="application/json")
    return base64.b64decode(json.loads(r["body"].read())["images"][0])


def _titan_v2(client, prompt: str, width: int, height: int) -> bytes:
    # Titan v2: dimensions must be multiples of 64, range 320-1408
    w = min(max((width  // 64) * 64, 320), 1408)
    h = min(max((height // 64) * 64, 320), 1408)
    body = {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {
            "text": prompt[:512],
            "negativeText": "blurry, low quality, distorted",
        },
        "imageGenerationConfig": {
            "numberOfImages": 1, "width": w, "height": h,
            "cfgScale": 8.0, "seed": 42,
        },
    }
    r = client.invoke_model(modelId="amazon.titan-image-generator-v2:0", body=json.dumps(body),
                            contentType="application/json", accept="application/json")
    return base64.b64decode(json.loads(r["body"].read())["images"][0])


def _sdxl(client, prompt: str, width: int, height: int) -> bytes:
    # SDXL: multiples of 64, range 512-1536
    w = min(max((width  // 64) * 64, 512), 1536)
    h = min(max((height // 64) * 64, 512), 1536)
    body = {
        "text_prompts": [
            {"text": prompt[:2000], "weight": 1.0},
            {"text": "blurry, low quality, watermark", "weight": -1.0},
        ],
        "cfg_scale": 7, "steps": 30, "width": w, "height": h, "samples": 1,
    }
    r = client.invoke_model(modelId="stability.stable-diffusion-xl-v1:0", body=json.dumps(body),
                            contentType="application/json", accept="application/json")
    return base64.b64decode(json.loads(r["body"].read())["artifacts"][0]["base64"])


_MODELS = [("nova-canvas", _nova_canvas), ("titan-v2", _titan_v2), ("sdxl", _sdxl)]

_EOL_ERRORS = (
    "EndOfLife", "end of its life", "ResourceNotFoundException",
    "ValidationException", "AccessDeniedException", "not found",
)


def generate_image(prompt: str, width: int = 1024, height: int = 1024) -> Optional[bytes]:
    """
    Try image models in order. Returns PNG bytes or None — never raises.
    Callers must guard: if image_bytes: ... else: skip upload.
    """
    client = get_bedrock_runtime()
    for name, fn in _MODELS:
        try:
            log.info(f"[bedrock] trying image model: {name}")
            data = fn(client, prompt, width, height)
            if data:
                log.info(f"[bedrock] image OK via {name}")
                return data
        except Exception as e:
            msg = str(e)
            if any(k in msg for k in _EOL_ERRORS):
                log.warning(f"[bedrock] {name} unavailable ({msg[:120]}) — trying next")
                continue
            log.error(f"[bedrock] {name} unexpected error ({msg[:200]}) — trying next")
            continue
    log.error("[bedrock] all image models failed — returning None")
    return None
