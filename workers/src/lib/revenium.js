/**
 * Revenium AI metering for Cloudflare Workers
 *
 * Endpoint:
 * POST https://api.revenium.ai/meter/v2/ai/completions
 *
 * Authentication:
 * x-api-key: <Revenium API key>
 *
 * Instrumented centrally in cf-ai.js / image-gen.js (not at every call site)
 * so every workflow step (blog posts, lead emails, social posts, payment
 * follow-ups, lead gen, image generation, and the /approvals regenerate
 * endpoint) is metered automatically without touching each step file.
 */

const REVENIUM_METERING_URL =
  "https://api.revenium.ai/meter/v2/ai/completions";

const ORGANIZATION_NAME = "Stellar Global Supplies";
const PRODUCT_NAME = "stellar-workflows";
const PROVIDER = "Cloudflare";

/**
 * Resolve Revenium API key from:
 * - normal Worker env variable / Wrangler secret
 * - Cloudflare Secrets Store binding
 */
async function getReveniumApiKey(env) {
  const binding = env.REVENIUM_API_KEY;

  if (!binding) {
    return null;
  }

  // Normal Wrangler secret / environment variable
  if (typeof binding === "string") {
    return binding.trim();
  }

  // Cloudflare Secrets Store
  if (typeof binding.get === "function") {
    try {
      const value = await binding.get();

      if (!value) {
        return null;
      }

      return String(value).trim();
    } catch (err) {
      console.warn(
        "[revenium] failed to resolve Secrets Store binding:",
        err?.message || err
      );

      return null;
    }
  }

  return null;
}

/**
 * Normalize Workers AI usage into Revenium's expected token fields.
 */
function normalizeUsage(usage) {
  if (!usage) {
    return {
      inputTokenCount: 0,
      outputTokenCount: 0,
      totalTokenCount: 0,
    };
  }

  const inputTokenCount = Number(
    usage.prompt_tokens ??
      usage.input_tokens ??
      usage.inputTokenCount ??
      0
  );

  const outputTokenCount = Number(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.outputTokenCount ??
      0
  );

  const totalTokenCount = Number(
    usage.total_tokens ??
      usage.totalTokenCount ??
      inputTokenCount + outputTokenCount
  );

  return {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,
  };
}

/**
 * Rough token estimate (chars/4) for call sites where Workers AI doesn't
 * return a usage block (e.g. FLUX image generation has no token concept —
 * only the text prompt going in is estimated).
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

/**
 * Report one AI request to Revenium.
 *
 * Call sites in cf-ai.js / image-gen.js are inside background job/step
 * functions, not user-facing HTTP responses, so this is simply awaited
 * inline rather than requiring ctx.waitUntil() threading through every
 * step file. If a Cloudflare ExecutionContext IS available at the call
 * site (e.g. api-router.js request handlers), pass it as `ctx` and this
 * will use ctx.waitUntil() instead so it never adds latency to a response.
 */
export async function reportUsage(
  env,
  {
    model,
    sessionId,
    usage,
    operationType = "CHAT",
    requestStartTime,
    ctx,
    provider = PROVIDER,
  }
) {
  const run = async () => {
    const apiKey = await getReveniumApiKey(env);
    const hasApiKey = Boolean(apiKey);

    if (!hasApiKey) {
      console.warn(
        "[revenium] REVENIUM_API_KEY not available — skipping usage report"
      );

      return;
    }

    const normalized = normalizeUsage(usage);

    const {
      inputTokenCount,
      outputTokenCount,
      totalTokenCount,
    } = normalized;

    if (
      inputTokenCount === 0 &&
      outputTokenCount === 0 &&
      totalTokenCount === 0
    ) {
      console.warn(
        "[revenium] no token usage found — skipping usage report"
      );

      return;
    }

    const requestTime = requestStartTime
      ? new Date(requestStartTime)
      : new Date();

    const completionStartTime = new Date();
    const responseTime = new Date();

    const requestDuration = Math.max(
      1,
      responseTime.getTime() - requestTime.getTime()
    );

    const payload = {
      model: model || "unknown",

      inputTokenCount,
      outputTokenCount,
      totalTokenCount,

      requestTime: requestTime.toISOString(),
      completionStartTime: completionStartTime.toISOString(),
      responseTime: responseTime.toISOString(),

      requestDuration,

      provider,
      stopReason: "STOP",
      operationType,

      organizationName: ORGANIZATION_NAME,
      productName: PRODUCT_NAME,

      subscriber: {
        id: sessionId || "unknown-session",
      },

      transactionId: crypto.randomUUID(),
    };

    try {
      const response = await fetch(REVENIUM_METERING_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      });

      const body = await response.text();

      if (!response.ok) {
        console.warn(
          "[revenium] metering call failed: " +
            JSON.stringify({
              status: response.status,
              statusText: response.statusText,
              body,
              endpoint: REVENIUM_METERING_URL,
              hasApiKey,
            })
        );

        return;
      }

      console.log(
        "[revenium] metering call successful:",
        JSON.stringify({
          status: response.status,
          model,
          operationType,
          inputTokenCount,
          outputTokenCount,
          totalTokenCount,
        })
      );
    } catch (err) {
      // Fire-and-forget: never let a Revenium outage break a workflow step.
      console.warn("[revenium] metering call errored:", err?.message || err);
    }
  };

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run());
    return;
  }

  // No ExecutionContext available (background job/step context) — await
  // inline. This never blocks an HTTP response since these call sites run
  // inside functions already wrapped in the top-level ctx.waitUntil(...) in
  // job-runner.js / schedule-runner.js.
  await run();
}
