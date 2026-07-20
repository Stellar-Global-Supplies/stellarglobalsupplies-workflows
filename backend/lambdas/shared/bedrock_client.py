"""
Bedrock client — Nova Pro for text, Nova Canvas + Stability AI for images.

Image fallback order:
  1. amazon.nova-canvas-v1:0       — AWS-native, no Marketplace needed, us-east-1
  2. stability.sd3-5-large-v1:0    — best quality,  ~$0.065/image (us-west-2, needs Marketplace)
  3. stability.stable-image-core-v1:0 — cheaper,    ~$0.003/image (us-west-2, needs Marketplace)
  4. Branded SVG placeholder        — zero cost, always works

Nova Canvas uses the same us-east-1 client as Nova Pro text — no extra client needed.
Stability models use a separate us-west-2 client.
"""
import boto3
import json
import base64
import os
import random
import threading
import urllib.request
import urllib.parse
from typing import Optional
from botocore.config import Config

# ─── boto3 clients (lazy-initialised, module-level singletons) ────────────────
_bedrock_text  = None   # us-east-1 — Nova Pro text + Nova Canvas image
_bedrock_image = None   # us-west-2 — Stability AI only

_BOTO_CFG = Config(
    connect_timeout=10,
    read_timeout=120,
    retries={"max_attempts": 0},   # Step Functions handles retries
)


def _get_text_client():
    global _bedrock_text
    if _bedrock_text is None:
        _bedrock_text = boto3.client(
            "bedrock-runtime",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            config=_BOTO_CFG,
        )
    return _bedrock_text


def _get_image_client():
    """us-west-2 client used only for Stability AI models."""
    global _bedrock_image
    if _bedrock_image is None:
        _bedrock_image = boto3.client(
            "bedrock-runtime",
            region_name="us-west-2",
            config=_BOTO_CFG,
        )
    return _bedrock_image


# ─── TEXT — Amazon Nova Pro ───────────────────────────────────────────────────
def generate_text(prompt: str, system: str = "", max_tokens: int = 2000) -> str:
    client   = _get_text_client()
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
    last_exc = None
    for attempt in range(2):
        text = generate_text(prompt, system=sys_p, max_tokens=max_tokens).strip()
        if text.startswith("```"):
            parts = text.split("```")
            text  = parts[1][4:] if parts[1].startswith("json") else parts[1]
        text = text.strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            last_exc = exc
            print(f"[bedrock] generate_json attempt {attempt+1} returned invalid JSON: {text[:200]}")
    raise ValueError(f"Nova returned invalid JSON after 2 attempts: {last_exc}") from last_exc


# ─── IMAGE 1 — Amazon Nova Canvas (us-east-1, no Marketplace needed) ─────────
def _invoke_nova_canvas(prompt: str, width: int = 1024, height: int = 1024) -> bytes:
    """
    Nova Canvas request schema:
      taskType / textToImageParams / imageGenerationConfig
    Response: {"images": ["<base64>"], "error": null}
    """
    # Nova Canvas supports these exact sizes — clamp to nearest 64-multiple
    w = max(320, min(4096, (width  // 64) * 64))
    h = max(320, min(4096, (height // 64) * 64))

    body = {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {
            "text": prompt[:1024],          # hard cap per AWS docs
        },
        "imageGenerationConfig": {
            "numberOfImages": 1,
            "quality":        "standard",   # "standard" | "premium"
            "width":          w,
            "height":         h,
            "seed":           random.randint(0, 858_993_459),
        },
    }
    print(f"[bedrock] invoking amazon.nova-canvas-v1:0 ({w}×{h})")
    client = _get_text_client()                       # us-east-1, same as Nova Pro
    resp   = client.invoke_model(
        modelId      = "amazon.nova-canvas-v1:0",
        body         = json.dumps(body),
        contentType  = "application/json",
        accept       = "application/json",
    )
    result = json.loads(resp["body"].read())

    if result.get("error"):
        raise RuntimeError(f"Nova Canvas error: {result['error']}")

    img_bytes = base64.b64decode(result["images"][0])
    if len(img_bytes) < 1000:
        raise ValueError(f"Nova Canvas returned suspiciously small image: {len(img_bytes)} bytes")
    return img_bytes


# ─── IMAGE 2 — Stability AI via Bedrock (us-west-2, needs Marketplace) ───────
_STABILITY_MODELS = [
    "stability.sd3-5-large-v1:0",           # best quality
    "stability.stable-image-core-v1:0",     # cheaper fallback
]


def _invoke_stability(model_id: str, prompt: str) -> bytes:
    client = _get_image_client()
    body   = json.dumps({
        "prompt":        prompt[:10000],
        "mode":          "text-to-image",
        "aspect_ratio":  "1:1",
        "output_format": "png",
    })
    print(f"[bedrock] invoking {model_id}")
    resp = client.invoke_model(
        modelId     = model_id,
        body        = body,
        contentType = "application/json",
        accept      = "application/json",
    )
    result    = json.loads(resp["body"].read())
    img_bytes = base64.b64decode(result["images"][0])
    if len(img_bytes) < 1000:
        raise ValueError(f"Image too small: {len(img_bytes)} bytes")
    return img_bytes


# ─── IMAGE fallback — Branded SVG placeholder (always works) ─────────────────
def _branded_svg_placeholder(prompt: str, width: int = 1024, height: int = 1024) -> bytes:
    label = (prompt[:58] + "…") if len(prompt) > 60 else prompt
    for ch, esc in [("&","&amp;"),("<","&lt;"),(">","&gt;"),("\"","&quot;")]:
        label = label.replace(ch, esc)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#0A2547"/>
      <stop offset="100%" stop-color="#1565C0"/>
    </linearGradient>
  </defs>
  <rect width="{width}" height="{height}" fill="url(#bg)"/>
  <rect x="40" y="40" width="{width-80}" height="{height-80}" rx="16"
        fill="none" stroke="#F59E0B" stroke-width="2" opacity="0.4"/>
  <circle cx="{width//2}" cy="{height//2 - 80}" r="54" fill="#F59E0B" opacity="0.15"/>
  <text x="{width//2}" y="{height//2 - 58}"
        font-family="Arial,sans-serif" font-size="64" font-weight="bold"
        fill="#F59E0B" text-anchor="middle">S</text>
  <text x="{width//2}" y="{height//2 + 10}"
        font-family="Arial,sans-serif" font-size="22" font-weight="600"
        fill="#FFFFFF" text-anchor="middle">Stellar Global Supplies</text>
  <text x="{width//2}" y="{height//2 + 46}"
        font-family="Arial,sans-serif" font-size="13"
        fill="#94A3B8" text-anchor="middle">{label}</text>
  <rect x="{width//2 - 52}" y="{height//2 + 72}" width="104" height="26" rx="13"
        fill="#F59E0B" opacity="0.18"/>
  <text x="{width//2}" y="{height//2 + 90}"
        font-family="Arial,sans-serif" font-size="11" font-weight="500"
        fill="#F59E0B" text-anchor="middle">AI · Placeholder</text>
</svg>"""
    return svg.encode("utf-8")


# ─── PUBLIC API ───────────────────────────────────────────────────────────────
def generate_image(prompt: str, width: int = 1024, height: int = 1024) -> Optional[bytes]:
    """
    Returns image bytes (PNG or SVG).

    Fallback order:
      1. Nova Canvas    — AWS-native, no Marketplace needed
      2. Stability SD3  — best quality, needs Marketplace subscription
      3. Stability Core — cheaper, needs Marketplace subscription
      4. SVG placeholder — always works, zero cost
    """
    # ── 1. Nova Canvas ────────────────────────────────────────
    try:
        data = _invoke_nova_canvas(prompt, width, height)
        print(f"[bedrock] Nova Canvas OK ({len(data):,} bytes)")
        return data
    except Exception as e:
        print(f"[bedrock] Nova Canvas failed ({str(e)[:200]}) — trying Stability")

    # ── 2 & 3. Stability AI ───────────────────────────────────
    for model_id in _STABILITY_MODELS:
        try:
            data = _invoke_stability(model_id, prompt)
            print(f"[bedrock] {model_id} OK ({len(data):,} bytes)")
            return data
        except Exception as e:
            print(f"[bedrock] {model_id} failed ({str(e)[:200]}) — trying next")

    # ── 4. SVG placeholder ────────────────────────────────────
    print("[bedrock] all image models failed — using branded SVG placeholder")
    return _branded_svg_placeholder(prompt, width, height)