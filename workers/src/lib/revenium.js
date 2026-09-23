/**
 * Revenium AI metering for Cloudflare Workers
 *
 * Cost calculation:
 *   - LiteLLM public model pricing catalog
 *   - Cost calculated locally from input/output token counts
 *   - Calculated cost sent to Revenium as:
 *       inputTokenCost
 *       outputTokenCost
 *       totalCost
 *
 * Revenium:
 * POST https://api.revenium.ai/meter/v2/ai/completions
 */

const REVENIUM_METERING_URL =
  "https://api.revenium.ai/meter/v2/ai/completions";

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

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

  if (typeof binding === "string") {
    return binding.trim();
  }

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
 * Normalize Workers AI usage into Revenium token fields.
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
 * does not return token usage.
 */
export function estimateTokens(text) {
  if (!text) return 0;

  return Math.max(
    1,
    Math.ceil(String(text).length / 4)
  );
}

/**
 * Normalize model names for LiteLLM lookup.
 *
 * Example:
 * @cf/meta/llama-4-scout-17b-16e-instruct
 *
 * LiteLLM may contain provider-specific prefixes,
 * so we try several representations.
 */
function getModelCandidates(model, provider) {
  const original = String(model || "").trim();

  if (!original) {
    return [];
  }

  const candidates = new Set();

  candidates.add(original);

  // Remove provider prefix such as @cf/
  if (original.includes("/")) {
    candidates.add(
      original.substring(original.lastIndexOf("/") + 1)
    );
  }

  // Remove @cf/ prefix
  candidates.add(
    original.replace(/^@cf\//i, "")
  );

  // Remove provider namespace
  candidates.add(
    original.replace(/^@[^/]+\//i, "")
  );

  // Cloudflare model aliases
  if (/llama-4-scout-17b-16e-instruct/i.test(original)) {
    candidates.add("llama-4-scout-17b-16e-instruct");
    candidates.add("meta-llama/llama-4-scout-17b-16e-instruct");
  }

  if (provider) {
    candidates.add(
      `${provider}/${original}`
    );
  }

  return [...candidates];
}

/**
 * Find pricing in LiteLLM's model catalog.
 *
 * LiteLLM pricing fields:
 *
 * input_cost_per_token
 * output_cost_per_token
 *
 * These are USD per token.
 */
function findLiteLLMPricing(catalog, model, provider) {
  if (!catalog || typeof catalog !== "object") {
    return null;
  }

  const candidates = getModelCandidates(model, provider);

  // Exact lookup first.
  for (const candidate of candidates) {
    const entry = catalog[candidate];

    if (
      entry &&
      (
        entry.input_cost_per_token !== undefined ||
        entry.output_cost_per_token !== undefined
      )
    ) {
      return {
        modelKey: candidate,
        inputCostPerToken: Number(
          entry.input_cost_per_token || 0
        ),
        outputCostPerToken: Number(
          entry.output_cost_per_token || 0
        ),
        source: "LiteLLM",
      };
    }
  }

  // Case-insensitive exact lookup.
  const catalogKeys = Object.keys(catalog);

  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();

    const matchingKey = catalogKeys.find(
      (key) => key.toLowerCase() === lowerCandidate
    );

    if (!matchingKey) {
      continue;
    }

    const entry = catalog[matchingKey];

    if (
      entry &&
      (
        entry.input_cost_per_token !== undefined ||
        entry.output_cost_per_token !== undefined
      )
    ) {
      return {
        modelKey: matchingKey,
        inputCostPerToken: Number(
          entry.input_cost_per_token || 0
        ),
        outputCostPerToken: Number(
          entry.output_cost_per_token || 0
        ),
        source: "LiteLLM",
      };
    }
  }

  // Last attempt: compare normalized model names.
  const normalizedTarget = String(model)
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9]/g, "");

  for (const key of catalogKeys) {
    const normalizedKey = key
      .toLowerCase()
      .replace(/^@[^/]+\//, "")
      .replace(/[^a-z0-9]/g, "");

    if (
      normalizedKey === normalizedTarget ||
      normalizedKey.endsWith(normalizedTarget) ||
      normalizedTarget.endsWith(normalizedKey)
    ) {
      const entry = catalog[key];

      if (
        entry &&
        (
          entry.input_cost_per_token !== undefined ||
          entry.output_cost_per_token !== undefined
        )
      ) {
        return {
          modelKey: key,
          inputCostPerToken: Number(
            entry.input_cost_per_token || 0
          ),
          outputCostPerToken: Number(
            entry.output_cost_per_token || 0
          ),
          source: "LiteLLM",
        };
      }
    }
  }

  return null;
}

/**
 * Fetch LiteLLM pricing catalog.
 *
 * Optional KV caching:
 *
 * Add to wrangler.toml:
 *
 * [[kv_namespaces]]
 * binding = "LITELLM_PRICING_KV"
 * id = "YOUR_KV_NAMESPACE_ID"
 *
 * If KV is not configured, this function simply fetches
 * the LiteLLM catalog directly.
 */
async function getLiteLLMPricingCatalog(env) {
  const cacheKey = "litellm:model-pricing:v1";

  // ---------------------------------------------------------
  // 1. Try KV cache
  // ---------------------------------------------------------
  if (env.LITELLM_PRICING_KV) {
    try {
      const cached = await env.LITELLM_PRICING_KV.get(
        cacheKey,
        "json"
      );

      if (cached) {
        console.log(
          "[revenium] LiteLLM pricing cache HIT"
        );

        return cached;
      }
    } catch (err) {
      console.warn(
        "[revenium] LiteLLM KV read failed:",
        err?.message || err
      );
    }
  }

  // ---------------------------------------------------------
  // 2. Fetch LiteLLM catalog
  // ---------------------------------------------------------
  console.log(
    "[revenium] LiteLLM pricing cache MISS — fetching catalog"
  );

  const response = await fetch(
    LITELLM_PRICING_URL,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "stellar-workflows-revenium-metering",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `LiteLLM pricing request failed: ${response.status} ${response.statusText}`
    );
  }

  const catalog = await response.json();

  // ---------------------------------------------------------
  // 3. Store in KV
  // ---------------------------------------------------------
  if (env.LITELLM_PRICING_KV) {
    try {
      // Cache for 24 hours.
      await env.LITELLM_PRICING_KV.put(
        cacheKey,
        JSON.stringify(catalog),
        {
          expirationTtl: 86400,
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
      await getLiteLLMPricingCatalog(env);

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

    const result = {
      inputTokenCost,
      outputTokenCost,
      totalCost,
      pricing,
    };

    console.log(
      "[revenium] calculated cost:",
      JSON.stringify({
        model,
        provider,
        inputTokenCount,
        outputTokenCount,
        inputTokenCost,
        outputTokenCost,
        totalCost,
        pricingModel: pricing.modelKey,
        pricingSource: pricing.source,
      })
    );

    return result;
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
    traceId,
    taskType,
    agent,
    transactionId,
  }
) {
  const run = async () => {
    const apiKey =
      await getReveniumApiKey(env);

    if (!apiKey) {
      console.warn(
        "[revenium] REVENIUM_API_KEY not available — skipping usage report"
      );

      return;
    }

    const normalized =
      normalizeUsage(usage);

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

    // ---------------------------------------------------------
    // Calculate cost locally using LiteLLM
    // ---------------------------------------------------------
    const cost =
      await calculateCost(env, {
        model,
        provider,
        inputTokenCount,
        outputTokenCount,
      });

    const payload = {
      model: model || "unknown",

      inputTokenCount,
      outputTokenCount,
      totalTokenCount,

      // -------------------------------------------------------
      // IMPORTANT:
      // Send our calculated cost to Revenium.
      // Do NOT ask Revenium to calculate it.
      // -------------------------------------------------------
      inputTokenCost:
        cost?.inputTokenCost ?? null,

      outputTokenCost:
        cost?.outputTokenCost ?? null,

      totalCost:
        cost?.totalCost ?? null,

      requestTime:
        requestTime.toISOString(),

      completionStartTime:
        completionStartTime.toISOString(),

      responseTime:
        responseTime.toISOString(),

      requestDuration,

      provider,

      // Actual model source/provider.
      modelSource: provider,

      stopReason: "STOP",

      operationType,

      costType: "AI",

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
        ? { traceId }
        : {}),

      ...(taskType
        ? { taskType }
        : {}),

      ...(agent
        ? { agent }
        : {}),
    };

    console.log(
      "[revenium] FINAL COST PAYLOAD:",
      JSON.stringify({
        model: payload.model,
        provider: payload.provider,
        modelSource: payload.modelSource,
        inputTokenCount:
          payload.inputTokenCount,
        outputTokenCount:
          payload.outputTokenCount,
        inputTokenCost:
          payload.inputTokenCost,
        outputTokenCost:
          payload.outputTokenCost,
        totalCost:
          payload.totalCost,
      })
    );

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
              JSON.stringify(payload),
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

          modelSource:
            provider,

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

          body,
        })
      );
    } catch (err) {
      console.warn(
        "[revenium] metering call errored:",
        err?.message || err
      );
    }
  };

  if (
    ctx &&
    typeof ctx.waitUntil === "function"
  ) {
    ctx.waitUntil(run());
    return;
  }

  await run();
}
