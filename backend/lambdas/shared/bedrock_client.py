"""
Bedrock client — Nova Pro for text, layered image fallback.

Image fallback order (cheapest/most available first):
  1. Pollinations.AI          — FREE, no key, no signup, real Flux AI images via HTTP
  2. amazon.nova-canvas-v1:0  — free once Model Access is enabled in Bedrock console
  3. stability.stable-image-core-v1:0  — current Stability model on Bedrock
  4. stability.sd3-large-v1:0          — SD3 on Bedrock
  5. Branded SVG placeholder  — pure Python, zero cost, always works, stored in S3 as .svg

Other cheap options (not wired in here, easy to add):
  - Replicate Flux:    ~$0.003/image  https://replicate.com  (REPLICATE_API_TOKEN)
  - Fal.ai Flux:       ~$0.003/image  https://fal.ai         (FAL_KEY)
  - Stability AI direct: $0.003-0.08  https://stability.ai   (separate from Bedrock)
"""
import boto3
import json
import base64
import os
import logging
import urllib.request
import urllib.parse
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


# ─── TEXT — Amazon Nova Pro ───────────────────────────────────────────────────
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


# ─── IMAGE option 1: Pollinations.AI ─────────────────────────────────────────
# Free · No API key · No signup · Real Flux AI · Plain HTTP GET
# Docs: https://pollinations.ai
def _pollinations(prompt: str, width: int = 1024, height: int = 1024) -> Optional[bytes]:
    # Clamp to supported range
    w = min(max(width,  256), 1920)
    h = min(max(height, 256), 1920)
    encoded = urllib.parse.quote(prompt[:500], safe="")
    url = (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width={w}&height={h}&model=flux&nologo=true&enhance=false"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "StellarWorkflows/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:   # follows redirect automatically
        data = resp.read()
    if len(data) < 1000:                                    # sanity: real image > 1KB
        raise ValueError(f"Pollinations returned suspiciously small payload: {len(data)} bytes")
    return data


# ─── IMAGE option 2-4: Bedrock models ────────────────────────────────────────
def _nova_canvas(client, prompt: str, width: int, height: int) -> bytes:
    w = min(max((width  // 64) * 64, 320), 1408)
    h = min(max((height // 64) * 64, 320), 1408)
    body = {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {"text": prompt[:512]},
        "imageGenerationConfig": {
            "numberOfImages": 1, "width": w, "height": h,
            "quality": "standard", "cfgScale": 8.0,
        },
    }
    r = client.invoke_model(modelId="amazon.nova-canvas-v1:0", body=json.dumps(body),
                            contentType="application/json", accept="application/json")
    return base64.b64decode(json.loads(r["body"].read())["images"][0])


def _stable_image_core(client, prompt: str, width: int, height: int) -> bytes:
    body = {"prompt": prompt[:10000], "aspect_ratio": "1:1", "output_format": "png"}
    r = client.invoke_model(modelId="stability.stable-image-core-v1:0", body=json.dumps(body),
                            contentType="application/json", accept="application/json")
    return base64.b64decode(json.loads(r["body"].read())["images"][0])


def _sd3_large(client, prompt: str, width: int, height: int) -> bytes:
    body = {"prompt": prompt[:10000], "mode": "text-to-image", "output_format": "png"}
    r = client.invoke_model(modelId="stability.sd3-large-v1:0", body=json.dumps(body),
                            contentType="application/json", accept="application/json")
    return base64.b64decode(json.loads(r["body"].read())["images"][0])


# ─── IMAGE option 5: Branded SVG placeholder ─────────────────────────────────
# Pure Python · zero cost · zero deps · always works
# Produces a branded navy/gold SVG — readable in any browser/img tag
def _branded_svg_placeholder(prompt: str, width: int = 1024, height: int = 1024) -> bytes:
    # Extract first ~60 chars as label
    label   = (prompt[:58] + "…") if len(prompt) > 60 else prompt
    # Escape XML special chars
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
  <!-- S logo mark -->
  <circle cx="{width//2}" cy="{height//2 - 80}" r="54" fill="#F59E0B" opacity="0.15"/>
  <text x="{width//2}" y="{height//2 - 58}"
        font-family="Arial,sans-serif" font-size="64" font-weight="bold"
        fill="#F59E0B" text-anchor="middle">S</text>
  <!-- Company name -->
  <text x="{width//2}" y="{height//2 + 10}"
        font-family="Arial,sans-serif" font-size="22" font-weight="600"
        fill="#FFFFFF" text-anchor="middle">Stellar Global Supplies</text>
  <!-- Prompt label -->
  <text x="{width//2}" y="{height//2 + 46}"
        font-family="Arial,sans-serif" font-size="13"
        fill="#94A3B8" text-anchor="middle">{label}</text>
  <!-- AI badge -->
  <rect x="{width//2 - 52}" y="{height//2 + 72}" width="104" height="26" rx="13"
        fill="#F59E0B" opacity="0.18"/>
  <text x="{width//2}" y="{height//2 + 90}"
        font-family="Arial,sans-serif" font-size="11" font-weight="500"
        fill="#F59E0B" text-anchor="middle">AI · Placeholder</text>
</svg>"""
    return svg.encode("utf-8")


# ─── Errors that mean "model not available" (skip, try next) ─────────────────
_SKIP_ERRORS = (
    "EndOfLife", "end of its life", "ResourceNotFoundException",
    "ValidationException", "AccessDeniedException", "Access denied", "marked",
)


def generate_image(prompt: str, width: int = 1024, height: int = 1024) -> Optional[bytes]:
    """
    Returns image bytes (PNG or SVG) or None.
    The SVG fallback means this almost never returns None.
    Callers check the extension via img_key to set correct ContentType.
    """

    # ── 1. Pollinations.AI (free, no key) ────────────────────
    try:
        log.info("[bedrock] trying Pollinations.AI (free)")
        data = _pollinations(prompt, width, height)
        if data:
            log.info(f"[bedrock] Pollinations OK ({len(data):,} bytes)")
            return data
    except Exception as e:
        log.warning(f"[bedrock] Pollinations failed ({str(e)[:120]}) — trying Bedrock")

    # ── 2-4. Bedrock models ───────────────────────────────────
    bedrock_models = [
        ("nova-canvas",        _nova_canvas),
        ("stable-image-core",  _stable_image_core),
        ("sd3-large",          _sd3_large),
    ]
    client = get_bedrock_runtime()
    for name, fn in bedrock_models:
        try:
            log.info(f"[bedrock] trying Bedrock model: {name}")
            data = fn(client, prompt, width, height)
            if data:
                log.info(f"[bedrock] {name} OK")
                return data
        except Exception as e:
            msg = str(e)
            if any(k in msg for k in _SKIP_ERRORS):
                log.warning(f"[bedrock] {name} unavailable ({msg[:120]}) — next")
            else:
                log.error(f"[bedrock] {name} error ({msg[:200]}) — next")
            continue

    # ── 5. Branded SVG placeholder (always works) ─────────────
    log.warning("[bedrock] all AI models failed — using branded SVG placeholder")
    return _branded_svg_placeholder(prompt, width, height)