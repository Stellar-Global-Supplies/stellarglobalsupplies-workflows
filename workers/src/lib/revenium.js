/**
 * Revenium AI metering for Cloudflare Workers
 *
 * Cost calculation:
 *   1. Get token usage from the AI response
 *   2. Check existing Cloudflare KV: AI_PRICING
 *   3. On cache miss, fetch LiteLLM pricing catalog
 *   4. Calculate input/output/total cost locally
 *   5. Send token usage + calculated cost to Revenium
 *
 * Existing values preserved:
 *   Organization: Stellar Global Supplies
 *   Product: stellar-workflows
 *   Provider: Cloudflare
 *
 * Existing KV binding:
 *   AI_PRICING
 */

const REVENIUM_METERING_URL =
  "https://api.revenium.ai/meter/v2/ai/completions";

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const ORGANIZATION_NAME = "Stellar Global Supplies";
const PRODUCT_NAME = "stellar-workflows";
const PROVIDER = "Cloudflare";

// Existing KV binding — DO NOT RENAME
const PRICING_KV_BINDING = "AI_PRICING";

// Pricing catalog cache duration: 24 hours
const PRICING_CACHE_TTL = 86400;

const PRICING_CACHE_KEY =
  "litellm:model-pricing:v1";

/**
 * Resolve Revenium API key from:
 *
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
 * Rough token estimate for call sites where Workers AI
 * does not return a usage block.
 *
 * Example:
 * FLUX image generation does not expose normal token
 * usage, so the text prompt can be estimated.
 */
export function estimateTokens(text) {
  if (!text) {
    return 0;
  }

  return Math.max(
    1,
    Math.ceil(String(text).length / 4)
  );
}

/**
 * Create model candidates for LiteLLM matching.
 *
 * Cloudflare example:
 *
 * @cf/meta/llama-4-scout-17b-16e-instruct
 *
 * LiteLLM may represent the same model with a different
 * provider prefix, so we try multiple forms.
 */
function getModelCandidates(model, provider) {
  const original =
    String(model || "").trim();

  if (!original) {
    return [];
  }

  const candidates = new Set();

  // Original model
  candidates.add(original);

  // Remove @cf/
  candidates.add(
    original.replace(/^@cf\//i, "")
  );

  // Remove generic provider prefix
  candidates.add(
    original.replace(/^@[^/]+\//i, "")
  );

  // Last segment after /
  if (original.includes("/")) {
    candidates.add(
      original.substring(
        original.lastIndexOf("/") + 1
      )
    );
  }

  // Provider/model
  if (provider) {
    candidates.add(
      `${provider}/${original}`
    );
  }

  // Known Cloudflare model normalization
  if (
    /llama-4-scout-17b-16e-instruct/i.test(
      original
    )
  ) {
    candidates.add(
      "llama-4-scout-17b-16e-instruct"
    );

    candidates.add(
      "meta-llama/llama-4-scout-17b-16e-instruct"
    );

    candidates.add(
      "cloudflare/@cf/meta/llama-4-scout-17b-16e-instruct"
    );
  }

  return [...candidates];
}

/**
 * Find model pricing inside LiteLLM catalog.
 *
 * LiteLLM fields:
 *
 * input_cost_per_token
 * output_cost_per_token
 */
function findLiteLLMPricing(
  catalog,
  model,
  provider
) {
  if (
    !catalog ||
    typeof catalog !== "object"
  ) {
    return null;
  }

  const candidates =
    getModelCandidates(
      model,
      provider
    );

  const catalogKeys =
    Object.keys(catalog);

  // ---------------------------------------------------------
  // 1. Exact key match
  // ---------------------------------------------------------
  for (const candidate of candidates) {
    const entry =
      catalog[candidate];

    if (
      entry &&
      (
        entry.input_cost_per_token !==
          undefined ||
        entry.output_cost_per_token !==
          undefined
      )
    ) {
      return {
        modelKey: candidate,

        inputCostPerToken:
          Number(
            entry.input_cost_per_token || 0
          ),

        outputCostPerToken:
          Number(
            entry.output_cost_per_token || 0
          ),

        source: "LiteLLM",
      };
    }
  }

  // ---------------------------------------------------------
  // 2. Case-insensitive exact match
  // ---------------------------------------------------------
  for (const candidate of candidates) {
    const lowerCandidate =
      candidate.toLowerCase();

    const matchingKey =
      catalogKeys.find(
        (key) =>
          key.toLowerCase() ===
          lowerCandidate
      );

    if (!matchingKey) {
      continue;
    }

    const entry =
      catalog[matchingKey];

    if (
      entry &&
      (
        entry.input_cost_per_token !==
          undefined ||
        entry.output_cost_per_token !==
          undefined
      )
    ) {
      return {
        modelKey: matchingKey,

        inputCostPerToken:
          Number(
            entry.input_cost_per_token || 0
          ),

        outputCostPerToken:
          Number(
            entry.output_cost_per_token || 0
          ),

        source: "LiteLLM",
      };
    }
  }

  // ---------------------------------------------------------
  // 3. Normalized model matching
  // ---------------------------------------------------------
  const normalizeForComparison =
    (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/^@[^/]+\//, "")
        .replace(/^cloudflare\//, "")
        .replace(/[^a-z0-9]/g, "");

  const targetCandidates =
    candidates.map(
      normalizeForComparison
    );

  for (const key of catalogKeys) {
    const normalizedKey =
      normalizeForComparison(key);

    const matched =
      targetCandidates.some(
        (target) =>
          normalizedKey === target ||
          normalizedKey.endsWith(target) ||
          target.endsWith(normalizedKey)
      );

    if (!matched) {
      continue;
    }

    const entry =
      catalog[key];

    if (
      entry &&
      (
        entry.input_cost_per_token !==
          undefined ||
        entry.output_cost_per_token !==
          undefined
      )
    ) {
      return {
        modelKey: key,

        inputCostPerToken:
          Number(
            entry.input_cost_per_token || 0
          ),

        outputCostPerToken:
          Number(
            entry.output_cost_per_token || 0
          ),

        source: "LiteLLM",
      };
    }
  }

  return null;
}

/**
 * Get LiteLLM pricing catalog.
 *
 * Uses existing KV binding:
 *
 *   env.AI_PRICING
 *
 * Cache:
 *   24 hours
 *
 * If KV is unavailable, the Worker continues by
 * fetching LiteLLM directly.
 */
async function getLiteLLMPricingCatalog(
  env
) {
  const kv =
    env[PRICING_KV_BINDING];

  // ---------------------------------------------------------
  // 1. KV CACHE
  // ---------------------------------------------------------
  if (kv) {
    try {
      const cached =
        await kv.get(
          PRICING_CACHE_KEY,
          "json"
        );

      if (cached) {
        console.log(
          "[revenium] LiteLLM pricing cache HIT"
        );

        return cached;
      }

      console.log(
        "[revenium] LiteLLM pricing cache MISS"
      );
    } catch (err) {
      console.warn(
        "[revenium] LiteLLM KV read failed:",
        err?.message || err
      );
    }
  } else {
    console.warn(
      "[revenium] AI_PRICING KV binding not available"
    );
  }

  // ---------------------------------------------------------
  // 2. FETCH LITELLM CATALOG
  // ---------------------------------------------------------
  try {
    console.log(
      "[revenium] fetching LiteLLM pricing catalog"
    );

    const response =
      await fetch(
        LITELLM_PRICING_URL,
        {
          method: "GET",

          headers: {
            Accept:
              "application/json",

            "User-Agent":
              "stellar-workflows-revenium-metering",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `LiteLLM pricing request failed: ${response.status} ${response.statusText}`
      );
    }

    const catalog =
      await response.json();

    // -------------------------------------------------------
    // 3. SAVE TO EXISTING KV
    // -------------------------------------------------------
    if (kv) {
      try {
        await kv.put(
          PRICING_CACHE_KEY,
          JSON.stringify(catalog),
          {
            expirationTtl:
              PRICING_CACHE_TTL,
          }
        );

        console.log(
          "[revenium] LiteLLM pricing catalog cached for 24h"
        );
      } catch (err) {
        console.warn(
          "[revenium] LiteLLM KV write failed:",
          err?.message || err
        );
      }
    }

    return catalog;
  } catch (err) {
    console.warn(
      "[revenium] LiteLLM catalog fetch failed:",
      err?.message || err
    );

    return null;
  }
}

/**
 * Calculate AI cost using LiteLLM pricing.
 */
async function calculateCost(
  env,
  {
    model,
    provider,
    inputTokenCount,
    outputTokenCount,
  }
) {
  try {
    const catalog =
      await getLiteLLMPricingCatalog(
        env
      );

    if (!catalog) {
      console.warn(
        "[revenium] pricing catalog unavailable"
      );

      return null;
    }

    const pricing =
      findLiteLLMPricing(
        catalog,
        model,
        provider
      );

    if (!pricing) {
      console.warn(
        "[revenium] LiteLLM pricing not found:",
        model
      );

      return null;
    }

    const inputTokenCost =
      inputTokenCount *
      pricing.inputCostPerToken;

    const outputTokenCost =
      outputTokenCount *
      pricing.outputCostPerToken;

    const totalCost =
      inputTokenCost +
      outputTokenCost;

    console.log(
      "[revenium] COST CALCULATED:",
      JSON.stringify({
        model,
        provider,

        inputTokenCount,
        outputTokenCount,

        inputCostPerToken:
          pricing.inputCostPerToken,

        outputCostPerToken:
          pricing.outputCostPerToken,

        inputTokenCost,
        outputTokenCost,
        totalCost,

        pricingModel:
          pricing.modelKey,

        pricingSource:
          pricing.source,
      })
    );

    return {
      inputTokenCost,
      outputTokenCost,
      totalCost,

      inputCostPerToken:
        pricing.inputCostPerToken,

      outputCostPerToken:
        pricing.outputCostPerToken,

      pricingModel:
        pricing.modelKey,

      pricingSource:
        pricing.source,
    };
  } catch (err) {
    console.warn(
      "[revenium] cost calculation failed:",
      err?.message || err
    );

    return null;
  }
}

/**
 * Report one AI request to Revenium.
 *
 * Existing call sites remain compatible.
 *
 * Optional:
 *   provider
 *   modelSource
 *   traceId
 *   taskType
 *   agent
 *   transactionId
 */
export async function reportUsage(
  env,
  {
    model,
    sessionId,
    usage,
    operationType = "GENERATE",
    requestStartTime,
    ctx,

    provider = PROVIDER,

    modelSource = provider,

    traceId,

    taskType,

    agent,

    transactionId,
  }
) {
  const run = async () => {
    // -------------------------------------------------------
    // REVENIUM API KEY
    // -------------------------------------------------------
    const apiKey =
      await getReveniumApiKey(
        env
      );

    if (!apiKey) {
      console.warn(
        "[revenium] REVENIUM_API_KEY not available — skipping usage report"
      );

      return;
    }

    // -------------------------------------------------------
    // TOKEN USAGE
    // -------------------------------------------------------
    const normalized =
      normalizeUsage(usage);

    const {
      inputTokenCount,
      outputTokenCount,
      totalTokenCount,
    } = normalized;

    console.log(
      "[revenium] TOKEN USAGE:",
      JSON.stringify({
        model,
        inputTokenCount,
        outputTokenCount,
        totalTokenCount,
      })
    );

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

    // -------------------------------------------------------
    // TIMING
    // -------------------------------------------------------
    const requestTime =
      requestStartTime
        ? new Date(requestStartTime)
        : new Date();

    const completionStartTime =
      new Date();

    const responseTime =
      new Date();

    const requestDuration =
      Math.max(
        1,
        responseTime.getTime() -
          requestTime.getTime()
      );

    // -------------------------------------------------------
    // LOCAL COST CALCULATION
    // -------------------------------------------------------
    const cost =
      await calculateCost(
        env,
        {
          model,
          provider,
          inputTokenCount,
          outputTokenCount,
        }
      );

    console.log(
      "[revenium] FINAL COST:",
      cost?.totalCost ?? null
    );

    // -------------------------------------------------------
    // REVENIUM PAYLOAD
    // -------------------------------------------------------
    const payload = {
      model:
        model || "unknown",

      provider,

      modelSource,

      inputTokenCount,

      outputTokenCount,

      totalTokenCount,

      // Our own calculated pricing.
      //
      // Keep full precision.
      // Do NOT round to cents.
      inputTokenCost:
        cost?.inputTokenCost ??
        null,

      outputTokenCost:
        cost?.outputTokenCost ??
        null,

      totalCost:
        cost?.totalCost ??
        null,

      requestTime:
        requestTime.toISOString(),

      completionStartTime:
        completionStartTime.toISOString(),

      responseTime:
        responseTime.toISOString(),

      requestDuration,

      stopReason:
        "STOP",

      operationType,

      costType:
        "AI",

      organizationName:
        ORGANIZATION_NAME,

      productName:
        PRODUCT_NAME,

      subscriber: {
        id:
          sessionId ||
          "unknown-session",
      },

      transactionId:
        transactionId ||
        crypto.randomUUID(),

      ...(traceId
        ? {
            traceId,
          }
        : {}),

      ...(taskType
        ? {
            taskType,
          }
        : {}),

      ...(agent
        ? {
            agent,
          }
        : {}),
    };

    console.log(
      "[revenium] FINAL COST PAYLOAD:",
      JSON.stringify({
        model:
          payload.model,

        provider:
          payload.provider,

        modelSource:
          payload.modelSource,

        inputTokenCount:
          payload.inputTokenCount,

        outputTokenCount:
          payload.outputTokenCount,

        totalTokenCount:
          payload.totalTokenCount,

        inputTokenCost:
          payload.inputTokenCost,

        outputTokenCost:
          payload.outputTokenCost,

        totalCost:
          payload.totalCost,
      })
    );

    // -------------------------------------------------------
    // REVENIUM METERING
    // -------------------------------------------------------
    try {
      const response =
        await fetch(
          REVENIUM_METERING_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              Accept:
                "application/json",

              "x-api-key":
                apiKey,
            },

            body:
              JSON.stringify(
                payload
              ),
          }
        );

      const body =
        await response.text();

      if (!response.ok) {
        console.warn(
          "[revenium] metering call failed:",
          JSON.stringify({
            status:
              response.status,

            statusText:
              response.statusText,

            body,

            endpoint:
              REVENIUM_METERING_URL,
          })
        );

        return;
      }

      console.log(
        "[revenium] metering call SUCCESS:",
        JSON.stringify({
          status:
            response.status,

          model,

          provider,

          modelSource,

          inputTokenCount,

          outputTokenCount,

          totalTokenCount,

          inputTokenCost:
            cost?.inputTokenCost ??
            null,

          outputTokenCost:
            cost?.outputTokenCost ??
            null,

          totalCost:
            cost?.totalCost ??
            null,

          transactionId:
            payload.transactionId,
        })
      );
    } catch (err) {
      // Revenium must never break the workflow.
      console.warn(
        "[revenium] metering call errored:",
        err?.message || err
      );
    }
  };

  // ---------------------------------------------------------
  // Cloudflare ExecutionContext
  // ---------------------------------------------------------
  if (
    ctx &&
    typeof ctx.waitUntil ===
      "function"
  ) {
    ctx.waitUntil(run());
    return;
  }

  // Background job / workflow context.
  await run();
}

// ═══════════════════════════════════════════════════════════════════════════
// AI Image Metering — dedicated endpoint, separate from /ai/completions.
// Images have no token concept (no inputTokenCount/outputTokenCount), so
// jamming them into the completions endpoint with estimated tokens was
// wrong. This endpoint bills by actualImageCount + billingUnit instead.
// ═══════════════════════════════════════════════════════════════════════════

const REVENIUM_IMAGE_METERING_URL =
  "https://api.revenium.ai/meter/v2/ai/images";

/**
 * Report one AI image generation/edit operation to Revenium.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string} opts.model            - e.g. '@cf/black-forest-labs/flux-1-schnell'
 * @param {string} opts.provider         - the actual model vendor, e.g. 'Black Forest Labs'
 *                                          (NOT the host — Cloudflare is the host, not the vendor)
 * @param {string} [opts.sessionId]
 * @param {string} [opts.agent]          - which agent/step triggered this, e.g. 'blog-content-agent'
 * @param {number} [opts.requestStartTime]
 * @param {number} [opts.actualImageCount=1]
 * @param {string} [opts.resolution]
 * @param {object} [opts.ctx]            - Cloudflare ExecutionContext, for waitUntil
 * @param {boolean} [opts.success=true]
 * @param {string} [opts.errorReason]
 */
export async function reportImageUsage(
  env,
  {
    model,
    provider,
    sessionId,
    agent,
    requestStartTime,
    actualImageCount = 1,
    resolution,
    ctx,
    success = true,
    errorReason,
    traceId,
    taskType = "image-generation",
  }
) {
  const run = async () => {
    const apiKey = await getReveniumApiKey(env);
    const hasApiKey = Boolean(apiKey);

    if (!hasApiKey) {
      console.warn(
        "[revenium] REVENIUM_API_KEY not available — skipping image usage report"
      );
      return;
    }

    const requestTime = requestStartTime
      ? new Date(requestStartTime)
      : new Date();
    const responseTime = new Date();
    const requestDuration = Math.max(
      1,
      responseTime.getTime() - requestTime.getTime()
    );

    const payload = {
      model: model || "unknown",
      provider: provider || "unknown",

      requestTime: requestTime.toISOString(),
      responseTime: responseTime.toISOString(),
      requestDuration,

      operationType: "IMAGE",
      billingUnit: "PER_IMAGE",
      actualImageCount,

      ...(resolution ? { resolution } : {}),

      costType: "AI",

      organizationName: ORGANIZATION_NAME,
      productName: PRODUCT_NAME,

      taskType,

      subscriber: {
        id: sessionId || "unknown-session",
      },

      transactionId: crypto.randomUUID(),

      ...(traceId ? { traceId } : {}),
      ...(agent ? { agent } : {}),
      ...(!success ? { errorReason: errorReason || "unknown error" } : {}),
    };

    try {
      const response = await fetch(REVENIUM_IMAGE_METERING_URL, {
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
          "[revenium] image metering call failed:",
          JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            body,
            endpoint: REVENIUM_IMAGE_METERING_URL,
          })
        );
        return;
      }

      console.log(
        "[revenium] image metering call SUCCESS:",
        JSON.stringify({
          status: response.status,
          model,
          provider,
          actualImageCount,
          agent,
          transactionId: payload.transactionId,
        })
      );
    } catch (err) {
      console.warn("[revenium] image metering call errored:", err?.message || err);
    }
  };

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run());
    return;
  }

  await run();
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Metering — for external tool/API calls that aren't LLM completions
// at all (Tavily search/extract, and any future non-AI external service).
// Dedicated endpoint: /meter/v2/tool/events.
//
// NOTE: costUsd only auto-calculates if a matching Tool (by toolId) has been
// registered in Revenium's Tool Registry (dashboard → Tools) with pricing.
// Until that's set up, these events still report duration/success/agent
// attribution — cost just shows as null/$0 until the tool is registered.
// ═══════════════════════════════════════════════════════════════════════════

const REVENIUM_TOOL_METERING_URL =
  "https://api.revenium.ai/meter/v2/tool/events";

/**
 * Report one external tool call to Revenium.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string} opts.toolId           - must match a Tool registered in
 *                                          Revenium's Tool Registry for cost
 *                                          to auto-calculate, e.g. 'tavily-search'
 * @param {string} [opts.operation]      - e.g. 'search', 'extract'
 * @param {number} [opts.durationMs]
 * @param {boolean} [opts.success=true]
 * @param {string} [opts.errorMessage]
 * @param {string} [opts.agent]
 * @param {string} [opts.workflowId]     - e.g. ctx.workflow_run_id
 * @param {string} [opts.agenticJobId]
 * @param {string} [opts.traceId]
 * @param {object} [opts.usageMetadata]  - freeform key-value extras (e.g. query, resultCount)
 * @param {object} [opts.ctx]            - Cloudflare ExecutionContext, for waitUntil
 */
export async function reportToolEvent(
  env,
  {
    toolId,
    operation,
    durationMs,
    success = true,
    errorMessage,
    agent,
    workflowId,
    agenticJobId,
    traceId,
    usageMetadata,
    ctx,
  }
) {
  const run = async () => {
    const apiKey = await getReveniumApiKey(env);
    const hasApiKey = Boolean(apiKey);

    if (!hasApiKey) {
      console.warn(
        "[revenium] REVENIUM_API_KEY not available — skipping tool event report"
      );
      return;
    }

    if (!toolId) {
      console.warn("[revenium] reportToolEvent called without toolId — skipping");
      return;
    }

    const payload = {
      toolId,
      timestamp: new Date().toISOString(),

      ...(operation ? { operation } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      success,
      ...(!success && errorMessage ? { errorMessage } : {}),

      organizationName: ORGANIZATION_NAME,
      productName: PRODUCT_NAME,

      ...(agent ? { agent } : {}),
      ...(workflowId ? { workflowId } : {}),
      ...(agenticJobId ? { agenticJobId } : {}),
      ...(traceId ? { traceId } : {}),
      ...(usageMetadata ? { usageMetadata } : {}),

      transactionId: crypto.randomUUID(),
    };

    try {
      const response = await fetch(REVENIUM_TOOL_METERING_URL, {
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
          "[revenium] tool event call failed:",
          JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            body,
            endpoint: REVENIUM_TOOL_METERING_URL,
          })
        );
        return;
      }

      console.log(
        "[revenium] tool event call SUCCESS:",
        JSON.stringify({
          status: response.status,
          toolId,
          operation,
          durationMs,
          success,
          agent,
          transactionId: payload.transactionId,
        })
      );
    } catch (err) {
      console.warn("[revenium] tool event call errored:", err?.message || err);
    }
  };

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run());
    return;
  }

  await run();
}
