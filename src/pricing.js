const USD_PER_MILLION = 1_000_000;

const BUILTIN_PRICES = {
  "deepseek-v4-pro": {
    provider: "deepseek",
    inputUSDPerMTok: 0.435,
    cacheReadUSDPerMTok: 0.003625,
    outputUSDPerMTok: 0.87,
    source: "deepseek_api_docs_2026-07-09",
  },
  "deepseek-v4-flash": {
    provider: "deepseek",
    inputUSDPerMTok: 0.14,
    cacheReadUSDPerMTok: 0.0028,
    outputUSDPerMTok: 0.28,
    source: "deepseek_api_docs_2026-07-09",
  },
};

const MODEL_ALIASES = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-flash",
};

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function normalizeModelName(model) {
  return String(model || "unknown").trim().toLowerCase();
}

function sourceAgent(event) {
  return event?.source === "claude" ? "claude" : "codex";
}

function configModels(config = {}) {
  return config.pricing?.models && typeof config.pricing.models === "object"
    ? config.pricing.models
    : {};
}

function configFallbacks(config = {}) {
  return {
    codex: "deepseek-v4-pro",
    ...(config.pricing?.fallbacks || {}),
  };
}

function priceForModel(model, config = {}) {
  const normalized = normalizeModelName(model);
  const aliased = MODEL_ALIASES[normalized] || normalized;
  const overrides = configModels(config);
  return overrides[normalized] || overrides[aliased] || BUILTIN_PRICES[aliased] || null;
}

function resolvePrice(event, config = {}) {
  const direct = priceForModel(event.model, config);
  if (direct) {
    return { model: normalizeModelName(event.model), price: direct, fallback: false };
  }

  const fallbackModel = configFallbacks(config)[sourceAgent(event)];
  if (!fallbackModel) return null;
  const fallbackPrice = priceForModel(fallbackModel, config);
  if (!fallbackPrice) return null;
  return { model: normalizeModelName(fallbackModel), price: fallbackPrice, fallback: true };
}

export function calculateEventCostUSD(event, config = {}) {
  if (config.pricing?.enabled === false) return null;
  const resolved = resolvePrice(event, config);
  if (!resolved) return null;

  const price = resolved.price;
  const input = number(event.inputTokens);
  const cacheRead = number(event.cacheReadTokens);
  const cacheCreation = number(event.cacheCreationTokens);
  const output = number(event.outputTokens);

  const inputCost = input * number(price.inputUSDPerMTok) / USD_PER_MILLION;
  const cacheReadCost = cacheRead * number(price.cacheReadUSDPerMTok ?? price.inputUSDPerMTok) / USD_PER_MILLION;
  const cacheCreationCost = cacheCreation * number(price.cacheCreationUSDPerMTok ?? price.inputUSDPerMTok) / USD_PER_MILLION;
  const outputCost = output * number(price.outputUSDPerMTok) / USD_PER_MILLION;
  return inputCost + cacheReadCost + cacheCreationCost + outputCost;
}

export function priceEvents(events = [], config = {}, options = {}) {
  if (options.noCost || config.pricing?.enabled === false) {
    return {
      events,
      meta: {
        available: false,
        confidence: "disabled",
        priced_events: 0,
        unpriced_events: events.length,
      },
    };
  }

  let priced = 0;
  let fallbackPriced = 0;
  const unpricedModels = new Set();
  const usedPrices = new Map();

  const pricedEvents = events.map((event) => {
    const resolved = resolvePrice(event, config);
    if (!resolved) {
      unpricedModels.add(event.model || "unknown");
      return { ...event, costUSD: null };
    }
    const costUSD = calculateEventCostUSD(event, config);
    if (costUSD === null) {
      unpricedModels.add(event.model || "unknown");
      return { ...event, costUSD: null };
    }
    priced += 1;
    if (resolved.fallback) fallbackPriced += 1;
    const existing = usedPrices.get(resolved.model);
    usedPrices.set(resolved.model, {
      ...resolved.price,
      fallback: Boolean(existing?.fallback || resolved.fallback),
    });
    return {
      ...event,
      costUSD,
      costPricingModel: resolved.model,
      costPricingFallback: resolved.fallback,
    };
  });

  return {
    events: pricedEvents,
    meta: {
      available: priced > 0,
      confidence: unpricedModels.size > 0 ? "partial_priced" : "priced",
      priced_events: priced,
      fallback_priced_events: fallbackPriced,
      unpriced_events: events.length - priced,
      unpriced_models: [...unpricedModels].sort(),
      models: Object.fromEntries(usedPrices),
    },
  };
}
