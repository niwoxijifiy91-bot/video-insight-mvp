import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configureProviderPrices, providerCostSummary, recordProviderUsage, todayProviderOperationCount, todayProviderSpendCny } from "./cost-ledger.mjs";
import { fetchTikHubDouyinWorkDetail } from "./tikhub-client.mjs";

const DEFAULT_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/responses";
const OFFICIAL_SAMPLE_VIDEO = "https://vod-ai-test.tos-cn-beijing.volces.com/demo/demo_480p.mp4";
const ANALYSIS_VERSION = "video-demand-v1";

let settingsPath = "";
let secretsPath = "";

function defaultSettings() {
  return {
    version: 1,
    enabled: true,
    provider: "volcengine-ark",
    endpoint: DEFAULT_ENDPOINT,
    modelId: "doubao-seed-2-0-lite-260428",
    concurrency: 3,
    dailyBudgetCny: 20,
    dailyVideoLimit: 200,
    inputCnyPerMillionTokens: 0.6,
    outputCnyPerMillionTokens: 3.6,
    tikhubUsdPerRequest: 0.001,
    usdCnyRate: 7.2,
    analysisVersion: ANALYSIS_VERSION,
  };
}

function readJson(filePath, fallback) {
  try { return JSON.parse(readFileSync(filePath, "utf8")); }
  catch { return structuredClone(fallback); }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function cleanText(value, max = 4000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function confidencePercent(value) {
  const score = Number(value || 0);
  const normalized = score > 0 && score <= 1 ? score * 100 : score;
  return Math.min(100, Math.max(0, Math.round(normalized)));
}

function directorScorePercent(value) {
  const score = Number(value || 0);
  const normalized = score > 0 && score <= 10 ? score * 10 : score;
  return Math.min(100, Math.max(0, Math.round(normalized)));
}

function textList(value, limit = 20, max = 800) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => cleanText(typeof item === "object" ? item?.text || item?.label || item?.detail || "" : item, max))
    .filter(Boolean)
    .slice(0, limit);
}

function parseJsonResponse(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(cleaned); }
  catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); }
      catch {}
    }
  }
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const stack = [];
  let inString = false;
  let escaped = false;
  let candidate = "";
  for (const char of cleaned.slice(start)) {
    if (inString) {
      if (escaped) {
        candidate += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        candidate += char;
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      candidate += char === "\n" || char === "\r" ? "\\n" : char;
      continue;
    }
    if (char === "\"") inString = true;
    if (char === "{" || char === "[") stack.push(char);
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) break;
      stack.pop();
    }
    candidate += char;
    if (!stack.length) break;
  }
  if (inString) candidate += "\"";
  while (stack.length) candidate += stack.pop() === "{" ? "}" : "]";
  candidate = candidate.replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(candidate); }
  catch {}
  return null;
}

export function parseVideoAnalysisJson(text) {
  return parseJsonResponse(text);
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.output)) {
    return payload.output.flatMap((item) => item?.content || [])
      .map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "")
      .filter(Boolean)
      .join("");
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item?.text || item?.content || "").join("");
  return "";
}

function normalizeEvidence(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    time_range: cleanText(item?.time_range || item?.time, 80),
    modality: cleanText(item?.modality || item?.evidence_type, 80),
    observation: cleanText(item?.observation || item?.detail, 1600),
    confidence: confidencePercent(item?.confidence),
  })).filter((item) => item.observation).slice(0, 30);
}

export function normalizeVideoAnalysis(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const structure = source.structure && typeof source.structure === "object" ? source.structure : {};
  const business = source.business_signals && typeof source.business_signals === "object" ? source.business_signals : {};
  const confidence = confidencePercent(source.confidence);
  return {
    title: cleanText(source.title, 500),
    one_sentence: cleanText(source.one_sentence, 1000),
    summary: cleanText(source.summary, 5000),
    target_audience: cleanText(source.target_audience, 1200),
    creator_intent: cleanText(source.creator_intent, 1200),
    primary_topic: cleanText(source.primary_topic, 500),
    topics: textList(source.topics, 12, 300),
    knowledge_points: textList(source.knowledge_points, 20, 500),
    creator_claims: textList(source.creator_claims, 20, 800),
    demonstrated_steps: textList(source.demonstrated_steps, 20, 800),
    tools_or_models: textList(source.tools_or_models, 20, 300),
    costs_mentioned: textList(source.costs_mentioned, 12, 500),
    outcomes_claimed: textList(source.outcomes_claimed, 12, 800),
    limitations_or_risks: textList(source.limitations_or_risks, 12, 800),
    audience_concerns: textList(source.audience_concerns, 12, 500),
    call_to_action: cleanText(source.call_to_action, 1200),
    structure: {
      opening_hook: cleanText(structure.opening_hook, 1200),
      structure_summary: cleanText(structure.structure_summary, 2400),
      pacing: cleanText(structure.pacing, 1200),
      visual_language: cleanText(structure.visual_language, 1600),
      audio_language: cleanText(structure.audio_language, 1600),
      retention_devices: textList(structure.retention_devices, 12, 500),
      beats: (Array.isArray(structure.beats) ? structure.beats : []).map((beat) => ({
        time_range: cleanText(beat?.time_range, 80),
        observed_content: cleanText(beat?.observed_content, 1200),
        narrative_function: cleanText(beat?.narrative_function, 800),
      })).filter((beat) => beat.observed_content || beat.narrative_function).slice(0, 24),
    },
    business_signals: {
      cost: cleanText(business.cost, 1000),
      efficiency: cleanText(business.efficiency, 1000),
      commercialization: cleanText(business.commercialization, 1200),
      implementation_barrier: cleanText(business.implementation_barrier, 1200),
      feasibility: cleanText(business.feasibility, 1200),
    },
    evidence: normalizeEvidence(source.evidence),
    confidence,
    uncertainty: textList(source.uncertainty, 12, 800),
    director_learning_reason: cleanText(source.director_learning_reason, 1200),
    director_learning_score: directorScorePercent(source.director_learning_score),
  };
}

export function calculateArkCost(usage, settings = defaultSettings()) {
  const inputTokens = Math.max(0, Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0));
  const outputTokens = Math.max(0, Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0));
  return Math.round((inputTokens / 1_000_000 * Number(settings.inputCnyPerMillionTokens || 0)
    + outputTokens / 1_000_000 * Number(settings.outputCnyPerMillionTokens || 0)) * 1_000_000) / 1_000_000;
}

export function buildVideoDemandPrompt(content = {}) {
  return `你是一名视频内容证据分析师。请直接观看并理解所提供的完整视频，包括画面、口播、字幕、时间顺序和演示过程。你的结果将与真实评论共同用于识别用户需求，因此必须区分视频中可观察事实与推断。

仅输出一个合法 JSON 对象，不要输出 Markdown 或额外文字。结构：
{
  "title":"准确概括视频的标题",
  "one_sentence":"一句话核心判断",
  "summary":"完整内容概要",
  "target_audience":"视频主要面向谁",
  "creator_intent":"博主希望观众理解、相信或行动什么",
  "primary_topic":"主要主题",
  "topics":["子主题"],
  "knowledge_points":["可跨作品匹配的具体知识点，不写宽泛标签"],
  "creator_claims":["博主明确提出的观点或主张"],
  "demonstrated_steps":["视频真实展示的步骤或过程"],
  "tools_or_models":["明确出现的工具、产品或模型"],
  "costs_mentioned":["明确提及的成本信息"],
  "outcomes_claimed":["博主声称或展示的结果"],
  "limitations_or_risks":["视频提到或画面可验证的限制"],
  "audience_concerns":["该内容直接回应的用户关注点"],
  "call_to_action":"结尾行动引导或建联方式，没有则写空字符串",
  "structure":{
    "opening_hook":"开头钩子",
    "structure_summary":"叙事与论证结构",
    "pacing":"节奏",
    "visual_language":"画面与镜头",
    "audio_language":"口播、音乐与音效",
    "retention_devices":["留存机制"],
    "beats":[{"time_range":"00:00-00:05","observed_content":"发生了什么","narrative_function":"这一段的作用"}]
  },
  "business_signals":{
    "cost":"成本信号",
    "efficiency":"效率信号",
    "commercialization":"商业化或获客信号",
    "implementation_barrier":"落地障碍",
    "feasibility":"视频中的项目想法是否有可执行依据；没有证据时明确待验证"
  },
  "evidence":[{"time_range":"00:00-00:05","modality":"画面/口播/字幕","observation":"可核验观察","confidence":85}],
  "confidence":85,
  "uncertainty":["无法确认的内容"],
  "director_learning_reason":"该视频结构是否值得进入编导学习候选及原因",
  "director_learning_score":80
}

要求：
1. knowledge_points 必须具体到可跨视频匹配，例如“Seedance 生成镜头一致性的提示词分层”，不要只写“AI视频”。
2. 不把博主的说法自动视为事实；使用“博主声称”“视频展示”。
3. evidence 尽量给出真实时间段。看不清或听不清时降低对应结论置信度。
4. 不根据发布文案补写视频中没有出现的信息。
5. 编导学习评分关注结构完整、表达清晰、证据展示和自然建联，不以夸张或诱导互动为优点。
6. confidence 和 evidence[].confidence 必须使用 0-100；director_learning_score 也必须使用 0-100。

平台元数据仅用于身份关联，不得替代观看：
${JSON.stringify({ account_name: content.account_name || "", published_at: content.published_at || "", publishing_copy: content.content_text || "" })}`;
}

export function initializeVideoInsight(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  settingsPath = path.join(stateDir, "video-insight-settings.json");
  secretsPath = path.join(stateDir, "video-insight-secrets.json");
  if (!existsSync(settingsPath)) writeJson(settingsPath, defaultSettings());
  else writeJson(settingsPath, { ...defaultSettings(), ...readJson(settingsPath, {}) });
  if (!existsSync(secretsPath)) writeJson(secretsPath, { version: 1, apiKey: "" });
  const settings = videoInsightSettings();
  configureProviderPrices(settings);
}

function secretState() {
  return readJson(secretsPath, { version: 1, apiKey: "" });
}

export function videoInsightSettings() {
  const settings = { ...defaultSettings(), ...readJson(settingsPath, {}) };
  const secret = secretState();
  const key = String(secret.apiKey || "");
  return {
    ...settings,
    apiKeyConfigured: Boolean(key),
    apiKeyMask: key ? `${key.slice(0, 3)}${"*".repeat(Math.min(12, Math.max(4, key.length - 6)))}${key.slice(-3)}` : "",
  };
}

export function saveVideoInsightSettings(input = {}) {
  const current = videoInsightSettings();
  const next = {
    ...defaultSettings(),
    ...readJson(settingsPath, {}),
    enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
    endpoint: cleanText(input.endpoint ?? current.endpoint, 500) || DEFAULT_ENDPOINT,
    modelId: cleanText(input.modelId ?? current.modelId, 160),
    concurrency: Math.min(6, Math.max(1, Number(input.concurrency ?? current.concurrency))),
    dailyBudgetCny: Math.min(100_000, Math.max(0, Number(input.dailyBudgetCny ?? current.dailyBudgetCny))),
    dailyVideoLimit: Math.min(10_000, Math.max(1, Number(input.dailyVideoLimit ?? current.dailyVideoLimit))),
    inputCnyPerMillionTokens: Math.max(0, Number(input.inputCnyPerMillionTokens ?? current.inputCnyPerMillionTokens)),
    outputCnyPerMillionTokens: Math.max(0, Number(input.outputCnyPerMillionTokens ?? current.outputCnyPerMillionTokens)),
    tikhubUsdPerRequest: Math.max(0, Number(input.tikhubUsdPerRequest ?? current.tikhubUsdPerRequest)),
    usdCnyRate: Math.max(0, Number(input.usdCnyRate ?? current.usdCnyRate)),
    analysisVersion: ANALYSIS_VERSION,
  };
  let endpoint;
  try { endpoint = new URL(next.endpoint); }
  catch {
    const error = new Error("火山方舟 API 地址格式不正确");
    error.statusCode = 400;
    throw error;
  }
  if (endpoint.protocol !== "https:") {
    const error = new Error("火山方舟 API 地址必须使用 HTTPS");
    error.statusCode = 400;
    throw error;
  }
  if (!next.modelId) {
    const error = new Error("模型 ID 不能为空");
    error.statusCode = 400;
    throw error;
  }
  writeJson(settingsPath, next);
  if (typeof input.apiKey === "string" && input.apiKey.trim()) writeJson(secretsPath, { version: 1, apiKey: input.apiKey.trim() });
  if (input.clearApiKey === true) writeJson(secretsPath, { version: 1, apiKey: "" });
  configureProviderPrices(next);
  return videoInsightSettings();
}

export function videoInsightReady() {
  const settings = videoInsightSettings();
  return Boolean(settings.enabled && settings.apiKeyConfigured && settings.modelId && settings.endpoint);
}

export function collectedVideoUrl(content, referenceTime = Date.now()) {
  return collectedVideoUrls(content, referenceTime)[0] || "";
}

function collectedVideoUrls(content, referenceTime = Date.now()) {
  if (content?.video_source_status === "stale") return [];
  const capturedAt = new Date(content?.video_source_captured_at || content?.collected_at || 0).getTime();
  if (!Number.isFinite(capturedAt) || capturedAt <= 0 || referenceTime - capturedAt > 10 * 60 * 1000) return [];
  const values = [content?.video_source_url, ...(Array.isArray(content?.video_source_candidates) ? content.video_source_candidates : [])];
  return [...new Set(values.map((value) => String(value || "").trim()).filter((value) => {
    try { return new URL(value).protocol === "https:"; }
    catch { return false; }
  }))];
}

function arkUsage(payload, settings) {
  const usage = payload?.usage || {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens, costCny: calculateArkCost(usage, settings) };
}

function requestAbortSignal(timeoutMs, externalSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
}

async function repairArkJsonOutput(raw, content, settings, apiKey, externalSignal) {
  if (!raw || raw.length > 120_000) return null;
  const startedAt = Date.now();
  let payload = {};
  try {
    const response = await fetch(settings.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.modelId,
        input: [{ role: "user", content: [{ type: "input_text", text: `修复下面这段视频分析结果，使其成为一个可解析的 JSON 对象。只修复 JSON 语法和被截断的结尾，不增加原文没有的事实；无法确认的缺失字段可省略。只输出 JSON。\n\n${raw}` }] }],
        thinking: { type: "disabled" },
        stream: false,
      }),
      signal: requestAbortSignal(60_000, externalSignal),
    });
    const text = await response.text();
    try { payload = JSON.parse(text); }
    catch { payload = {}; }
    const usage = arkUsage(payload, settings);
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `HTTP ${response.status}`), { statusCode: response.status });
    const repaired = parseJsonResponse(extractResponseText(payload));
    recordProviderUsage({
      provider: "volcengine-ark",
      operation: "video_json_repair",
      status: repaired ? "success" : "invalid_output",
      requestId: payload.id,
      contentId: content.id,
      model: settings.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costCny: usage.costCny,
      latencyMs: Date.now() - startedAt,
      errorCode: repaired ? "" : "invalid_json",
    });
    return repaired ? { parsed: repaired, usage, requestId: String(payload.id || ""), latencyMs: Date.now() - startedAt } : null;
  } catch (error) {
    if (externalSignal?.aborted || error?.name === "AbortError") throw error;
    recordProviderUsage({
      provider: "volcengine-ark",
      operation: "video_json_repair",
      status: "failed",
      contentId: content.id,
      model: settings.modelId,
      latencyMs: Date.now() - startedAt,
      errorCode: String(error?.code || "repair_failed").toLowerCase(),
    });
    return null;
  }
}

async function arkVideoRequest(videoUrl, content = {}, options = {}) {
  const settings = videoInsightSettings();
  const apiKey = String(secretState().apiKey || "").trim();
  const operation = String(options.operation || "video_analysis");
  if (!apiKey) {
    const error = new Error("火山方舟 API Key 未配置");
    error.statusCode = 409;
    throw error;
  }
  if (todayProviderSpendCny("volcengine-ark") >= Number(settings.dailyBudgetCny || 0) && Number(settings.dailyBudgetCny || 0) > 0) {
    const error = new Error("今日视频模型预算已用完");
    error.code = "BUDGET_LIMIT";
    error.statusCode = 429;
    throw error;
  }
  const todayVideoAttempts = todayProviderOperationCount("volcengine-ark", "video_analysis");
  if (operation === "video_analysis" && Number(settings.dailyVideoLimit || 0) > 0 && todayVideoAttempts >= Number(settings.dailyVideoLimit)) {
    const error = new Error("今日视频分析条数上限已达到");
    error.code = "BUDGET_LIMIT";
    error.statusCode = 429;
    throw error;
  }
  const startedAt = Date.now();
  let response;
  let payload = {};
  try {
    response = await fetch(settings.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.modelId,
        input: [{ role: "user", content: [{ type: "input_video", video_url: videoUrl }, { type: "input_text", text: buildVideoDemandPrompt(content) }] }],
        thinking: { type: "disabled" },
        stream: false,
      }),
      signal: requestAbortSignal(Number(options.timeoutMs || 180_000), options.signal),
    });
    const text = await response.text();
    try { payload = JSON.parse(text); }
    catch { payload = {}; }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`;
      const error = new Error(`火山方舟视频分析失败：${String(detail).slice(0, 500)}`);
      error.code = response.status === 429 ? "RATE_LIMIT" : "ARK_ERROR";
      error.statusCode = response.status;
      throw error;
    }
    const raw = extractResponseText(payload);
    const usage = arkUsage(payload, settings);
    let parsed = parseJsonResponse(raw);
    let repair = null;
    let unstructuredFallback = false;
    if (!parsed) {
      recordProviderUsage({
        provider: "volcengine-ark",
        operation,
        status: "invalid_output",
        requestId: payload.id,
        contentId: content.id,
        model: settings.modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costCny: usage.costCny,
        latencyMs: Date.now() - startedAt,
        errorCode: "invalid_json",
      });
      repair = await repairArkJsonOutput(raw, content, settings, apiKey, options.signal);
      parsed = repair?.parsed || null;
      if (!parsed && raw.trim()) {
        unstructuredFallback = true;
        parsed = {
          title: content.title || "视频内容分析结果",
          one_sentence: cleanText(raw, 600),
          summary: cleanText(raw, 5000),
          confidence: 20,
          uncertainty: ["模型未按约定返回 JSON，已保留原始分析文本；该结果需要人工复核。"],
          director_learning_score: 0,
        };
      }
      if (!parsed) throw Object.assign(new Error("模型未返回可用的视频分析文本"), { code: "EMPTY_MODEL_OUTPUT", statusCode: 502, usageRecorded: true });
    }
    const analysis = normalizeVideoAnalysis(parsed);
    const combinedUsage = repair ? {
      inputTokens: usage.inputTokens + repair.usage.inputTokens,
      outputTokens: usage.outputTokens + repair.usage.outputTokens,
      totalTokens: usage.totalTokens + repair.usage.totalTokens,
    } : usage;
    const costCny = usage.costCny + Number(repair?.usage.costCny || 0);
    if (!repair) recordProviderUsage({
      provider: "volcengine-ark",
      operation,
      status: "success",
      requestId: payload.id,
      contentId: content.id,
      model: settings.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costCny: usage.costCny,
      latencyMs: Date.now() - startedAt,
    });
    return { analysis, usage: combinedUsage, costCny, model: settings.modelId, requestId: [payload.id, repair?.requestId].filter(Boolean).join(","), latencyMs: Date.now() - startedAt, repairedJson: Boolean(repair), unstructuredFallback };
  } catch (error) {
    if (!error?.usageRecorded) recordProviderUsage({
      provider: "volcengine-ark",
      operation,
      status: "failed",
      contentId: content.id,
      model: settings.modelId,
      latencyMs: Date.now() - startedAt,
      errorCode: error?.code === "RATE_LIMIT" || error?.statusCode === 429 ? "rate_limit" : String(error?.code || "request_failed").toLowerCase(),
    });
    throw error;
  }
}

export async function analyzeDouyinContentVideo(content, options = {}) {
  if (content.platform !== "douyin" || !content.platform_content_id) throw new Error("仅支持带作品 ID 的抖音视频");
  let videoUrls = collectedVideoUrls(content);
  let videoUrlSource = videoUrls.length ? "tikhub_post_list" : "tikhub_work_detail_fallback";
  let usedTikHubDetailLookup = false;
  const attempted = new Set();
  let lastError = null;

  async function tryCandidates(values) {
    for (const videoUrl of values) {
      if (options.signal?.aborted) throw options.signal.reason || new DOMException("任务已取消", "AbortError");
      if (!videoUrl || attempted.has(videoUrl)) continue;
      attempted.add(videoUrl);
      try {
        const result = await arkVideoRequest(videoUrl, content, options);
        return { ...result, videoUrl, videoUrls: values, videoUrlSource, usedTikHubDetailLookup };
      } catch (error) {
        if (options.signal?.aborted || error?.name === "AbortError") throw error;
        lastError = error;
        if (!/Error while connecting|connect(?:ing|ion).*https?:\/\//i.test(String(error?.message || ""))) break;
      }
    }
    return null;
  }

  let result = await tryCandidates(videoUrls);
  if (result) return result;
  if (!videoUrls.length || /Error while connecting|connect(?:ing|ion).*https?:\/\//i.test(String(lastError?.message || ""))) {
    if (options.signal?.aborted) throw options.signal.reason || new DOMException("任务已取消", "AbortError");
    const { detail } = await fetchTikHubDouyinWorkDetail(content.platform_content_id, { retries: 1, timeoutMs: 40_000 });
    usedTikHubDetailLookup = true;
    videoUrlSource = "tikhub_work_detail_fallback";
    videoUrls = detail.videoUrls?.length ? detail.videoUrls : detail.videoUrl ? [detail.videoUrl] : [];
    result = await tryCandidates(videoUrls);
    if (result) return result;
  }
  const error = lastError || new Error("TikHub 未返回可供模型读取的视频直链");
  error.videoUrl = [...attempted].at(-1) || "";
  error.videoUrls = videoUrls;
  error.videoUrlSource = videoUrlSource;
  error.usedTikHubDetailLookup = usedTikHubDetailLookup;
  throw error;
}

export async function testVideoInsightConnection() {
  return arkVideoRequest(OFFICIAL_SAMPLE_VIDEO, { id: "connection-test", account_name: "官方样例", content_text: "连接测试" }, { timeoutMs: 180_000, operation: "connection_test" });
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const rows = Array.isArray(items) ? items : [];
  const limit = Math.min(Math.max(1, Number(concurrency || 1)), Math.max(1, rows.length));
  const results = new Array(rows.length);
  let cursor = 0;
  async function run() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = { status: "fulfilled", value: await worker(rows[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

export function createConcurrentWorkQueue(concurrency, worker) {
  const limit = Math.max(1, Math.min(6, Number(concurrency || 1)));
  const pending = [];
  const results = [];
  const drainWaiters = [];
  let active = 0;
  let closed = false;

  function settleDrain() {
    if (!closed || active || pending.length) return;
    while (drainWaiters.length) drainWaiters.shift()(results);
  }

  function dispatch() {
    while (active < limit && pending.length) {
      const task = pending.shift();
      active += 1;
      task.started();
      Promise.resolve()
        .then(() => worker(task.item))
        .then((value) => results.push({ status: "fulfilled", value }))
        .catch((reason) => results.push({ status: "rejected", reason }))
        .finally(() => {
          active -= 1;
          dispatch();
          settleDrain();
        });
    }
  }

  return {
    push(item) {
      if (closed) return Promise.reject(new Error("并发队列已经关闭"));
      return new Promise((resolve) => {
        pending.push({ item, started: () => resolve({ active, pending: pending.length }) });
        dispatch();
      });
    },
    close() {
      closed = true;
      dispatch();
      if (!active && !pending.length) return Promise.resolve(results);
      return new Promise((resolve) => drainWaiters.push(resolve));
    },
    state() {
      return { active, pending: pending.length, concurrency: limit, closed };
    },
  };
}

export function shanghaiDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function requestedShanghaiDayKey(reference = new Date()) {
  const direct = String(reference || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(direct) ? direct : shanghaiDayKey(reference);
}

export function previousShanghaiDayKey(reference = new Date()) {
  const date = reference instanceof Date ? reference : new Date(reference);
  return Number.isNaN(date.getTime()) ? "" : shanghaiDayKey(new Date(date.getTime() - 86_400_000));
}

export function isFirstStoredOnShanghaiDay(content, reference = new Date()) {
  return Boolean(content?.created_at) && shanghaiDayKey(content.created_at) === requestedShanghaiDayKey(reference);
}

export function isPublishedOnShanghaiDay(content, reference = new Date()) {
  return Boolean(content?.published_at) && shanghaiDayKey(content.published_at) === requestedShanghaiDayKey(reference);
}

export function videoAnalysisQueueBoundary(contents = [], reference = new Date()) {
  const douyin = contents.filter((item) => item.platform === "douyin" && item.status !== "reference_evidence");
  const pendingStatuses = new Set(["queued", "pending_config", "budget_paused", "failed"]);
  const incompatible = (item) => item.video_analysis_status === "incompatible"
    || (item.video_analysis_status !== "completed" && item.video_analysis_retryable === false)
    || /exceeds the limit \(50 MiB\)|size of the input video.*50 MiB|audio\/mp4|unsupported.*(?:mime|media|video)/i.test(String(item.video_analysis_error || ""));
  const pending = douyin.filter((item) => !incompatible(item) && (!item.video_analysis_status || pendingStatuses.has(item.video_analysis_status)));
  const today = douyin.filter((item) => isFirstStoredOnShanghaiDay(item, reference));
  const previousDayKey = previousShanghaiDayKey(reference);
  const previousDayBatch = today.filter((item) => isPublishedOnShanghaiDay(item, previousDayKey));
  return {
    douyin,
    pending,
    today,
    todayPending: pending.filter((item) => isFirstStoredOnShanghaiDay(item, reference)),
    historicalPending: pending.filter((item) => !isFirstStoredOnShanghaiDay(item, reference)),
    previousDayKey,
    previousDayBatch,
    previousDayBatchPending: pending.filter((item) => isFirstStoredOnShanghaiDay(item, reference) && isPublishedOnShanghaiDay(item, previousDayKey)),
  };
}

export function videoInsightSummary(contents = [], reference = new Date()) {
  const settings = videoInsightSettings();
  const { douyin, pending, today, todayPending, historicalPending, previousDayKey, previousDayBatch, previousDayBatchPending } = videoAnalysisQueueBoundary(contents, reference);
  const statusCount = (status) => douyin.filter((item) => item.video_analysis_status === status).length;
  const costs = providerCostSummary({ currentConcurrency: settings.concurrency });
  return {
    ready: videoInsightReady(),
    settings,
    queue: {
      total: douyin.length,
      completed: statusCount("completed"),
      pending: pending.length,
      analyzing: statusCount("analyzing"),
      failed: statusCount("failed"),
      incompatible: statusCount("incompatible"),
      todayTotal: today.length,
      todayCompleted: today.filter((item) => item.video_analysis_status === "completed").length,
      todayPending: todayPending.length,
      historicalPending: historicalPending.length,
      previousDayKey,
      previousDayTotal: previousDayBatch.length,
      previousDayCompleted: previousDayBatch.filter((item) => item.video_analysis_status === "completed").length,
      previousDayPending: previousDayBatchPending.length,
      learningPending: 0,
    },
    costs,
  };
}

export function tikHubRequestCost() {
  const settings = videoInsightSettings();
  return {
    costUsd: Number(settings.tikhubUsdPerRequest || 0),
    costCny: Number(settings.tikhubUsdPerRequest || 0) * Number(settings.usdCnyRate || 0),
  };
}
