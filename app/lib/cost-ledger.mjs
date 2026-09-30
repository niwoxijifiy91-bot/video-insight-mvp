import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

let ledgerPath = "";
let providerPrices = { tikhubUsdPerRequest: 0.001, usdCnyRate: 7.2 };

function emptyLedger() {
  return { version: 1, events: [] };
}

function readLedger() {
  if (!ledgerPath) return emptyLedger();
  try { return JSON.parse(readFileSync(ledgerPath, "utf8")); }
  catch { return emptyLedger(); }
}

function writeLedger(value) {
  if (!ledgerPath) return;
  writeFileSync(ledgerPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function shanghaiDay(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

export function initializeCostLedger(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  ledgerPath = path.join(stateDir, "provider-usage.json");
  if (!existsSync(ledgerPath)) writeLedger(emptyLedger());
}

export function configureProviderPrices(input = {}) {
  providerPrices = {
    tikhubUsdPerRequest: Math.max(0, Number(input.tikhubUsdPerRequest ?? providerPrices.tikhubUsdPerRequest)),
    usdCnyRate: Math.max(0, Number(input.usdCnyRate ?? providerPrices.usdCnyRate)),
  };
  return { ...providerPrices };
}

export function estimatedTikHubRequestCost() {
  return {
    costUsd: providerPrices.tikhubUsdPerRequest,
    costCny: providerPrices.tikhubUsdPerRequest * providerPrices.usdCnyRate,
  };
}

export function recordProviderUsage(input) {
  if (!ledgerPath) return null;
  const ledger = readLedger();
  const event = {
    id: String(input.id || crypto.randomUUID()),
    provider: String(input.provider || "unknown"),
    operation: String(input.operation || "request"),
    status: String(input.status || "success"),
    request_id: String(input.requestId || ""),
    content_id: String(input.contentId || ""),
    model: String(input.model || ""),
    input_tokens: Math.max(0, Number(input.inputTokens || 0)),
    output_tokens: Math.max(0, Number(input.outputTokens || 0)),
    total_tokens: Math.max(0, Number(input.totalTokens || 0)),
    cost_usd: round(input.costUsd),
    cost_cny: round(input.costCny),
    latency_ms: Math.max(0, Math.round(Number(input.latencyMs || 0))),
    error_code: String(input.errorCode || ""),
    created_at: input.createdAt || new Date().toISOString(),
  };
  ledger.events.unshift(event);
  ledger.events = ledger.events.slice(0, 20_000);
  writeLedger(ledger);
  return event;
}

export function providerCostSummary(options = {}) {
  const ledger = readLedger();
  const today = shanghaiDay();
  const sevenDaysAgo = Date.now() - 7 * 86_400_000;
  const billable = ledger.events.filter((item) => item.status === "success" || Number(item.cost_usd || 0) > 0 || Number(item.cost_cny || 0) > 0);
  const summarize = (items) => ({
    requests: items.length,
    inputTokens: items.reduce((sum, item) => sum + Number(item.input_tokens || 0), 0),
    outputTokens: items.reduce((sum, item) => sum + Number(item.output_tokens || 0), 0),
    totalTokens: items.reduce((sum, item) => sum + Number(item.total_tokens || 0), 0),
    costUsd: round(items.reduce((sum, item) => sum + Number(item.cost_usd || 0), 0), 4),
    costCny: round(items.reduce((sum, item) => sum + Number(item.cost_cny || 0), 0), 4),
    averageLatencyMs: items.length ? Math.round(items.reduce((sum, item) => sum + Number(item.latency_ms || 0), 0) / items.length) : 0,
  });
  const period = (provider, range) => billable.filter((item) => item.provider === provider && range(item));
  const todayRange = (item) => shanghaiDay(new Date(item.created_at)) === today;
  const weekRange = (item) => new Date(item.created_at).getTime() >= sevenDaysAgo;
  const recentArk = ledger.events.filter((item) => item.provider === "volcengine-ark" && item.operation === "video_analysis").slice(0, 100);
  const arkFailures = recentArk.filter((item) => item.status !== "success");
  const completedArk = recentArk.filter((item) => item.status === "success");
  const currentConcurrency = Math.max(1, Number(options.currentConcurrency || 1));
  let recommendedConcurrency = currentConcurrency;
  if (recentArk.some((item) => item.error_code === "rate_limit")) recommendedConcurrency = Math.max(1, currentConcurrency - 1);
  else if (completedArk.length >= 8 && arkFailures.length === 0) recommendedConcurrency = Math.min(6, currentConcurrency + 1);
  return {
    today: {
      tikhub: summarize(period("tikhub", todayRange)),
      ark: summarize(period("volcengine-ark", todayRange)),
    },
    last7Days: {
      tikhub: summarize(period("tikhub", weekRange)),
      ark: summarize(period("volcengine-ark", weekRange)),
    },
    concurrency: {
      current: currentConcurrency,
      recommended: recommendedConcurrency,
      observedRequests: recentArk.length,
      successRate: recentArk.length ? round(completedArk.length / recentArk.length * 100, 1) : 0,
      averageLatencyMs: completedArk.length ? Math.round(completedArk.reduce((sum, item) => sum + Number(item.latency_ms || 0), 0) / completedArk.length) : 0,
      rateLimitErrors: recentArk.filter((item) => item.error_code === "rate_limit").length,
    },
  };
}

export function todayProviderSpendCny(provider) {
  return providerCostSummary().today[provider === "tikhub" ? "tikhub" : "ark"].costCny;
}

export function todayProviderOperationCount(provider, operation) {
  const today = shanghaiDay();
  return readLedger().events.filter((item) => item.provider === provider
    && item.operation === operation
    && (item.status === "success" || Number(item.cost_usd || 0) > 0 || Number(item.cost_cny || 0) > 0 || item.error_code === "invalid_json")
    && shanghaiDay(new Date(item.created_at)) === today).length;
}
