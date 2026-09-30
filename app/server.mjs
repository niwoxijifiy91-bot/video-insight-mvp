import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  analyzeDouyinContentVideo,
  initializeVideoInsight,
  parseVideoAnalysisJson,
  saveVideoInsightSettings,
  videoInsightSettings,
} from "./lib/video-insight.mjs";
import {
  fetchTikHubDouyinWorkComments,
  fetchTikHubDouyinWorkDetail,
} from "./lib/tikhub-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.VIDEO_INSIGHT_DATA_DIR || path.join(__dirname, ".data"));
const publicDir = path.join(__dirname, "public");
const settingsPath = path.join(dataDir, "mvp-settings.json");
const jobsDir = path.join(dataDir, "jobs");
const port = Number(process.env.PORT || 3030);

mkdirSync(dataDir, { recursive: true });
mkdirSync(jobsDir, { recursive: true });
initializeVideoInsight(dataDir);

const defaultMvpSettings = {
  tikhubBaseUrl: process.env.TIKHUB_BASE_URL || "https://api.tikhub.io",
  commentsLimit: 50,
};

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return structuredClone(fallback); }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function mvpSettings() {
  return { ...defaultMvpSettings, ...readJson(settingsPath, {}) };
}

function applyTikHubSettings() {
  const settings = mvpSettings();
  process.env.TIKHUB_API_KEY = String(settings.tikhubApiKey || "").trim();
  process.env.TIKHUB_BASE_URL = String(settings.tikhubBaseUrl || defaultMvpSettings.tikhubBaseUrl).trim();
}

applyTikHubSettings();

function mask(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 3)}${"*".repeat(Math.min(12, Math.max(4, text.length - 6)))}${text.slice(-3)}` : "";
}

function publicSettings() {
  const ark = videoInsightSettings();
  const tikhub = mvpSettings();
  return {
    endpoint: ark.endpoint,
    modelId: ark.modelId,
    arkApiKeyConfigured: ark.apiKeyConfigured,
    arkApiKeyMask: ark.apiKeyMask,
    tikhubApiKeyConfigured: Boolean(tikhub.tikhubApiKey),
    tikhubApiKeyMask: mask(tikhub.tikhubApiKey),
    tikhubBaseUrl: tikhub.tikhubBaseUrl,
    commentsLimit: tikhub.commentsLimit,
  };
}

function updateJob(id, patch) {
  const file = path.join(jobsDir, `${id}.json`);
  const current = readJson(file, { id, status: "queued", createdAt: new Date().toISOString() });
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeJson(file, next);
  return next;
}

function getJob(id) {
  const file = path.join(jobsDir, `${id}.json`);
  if (!existsSync(file)) return null;
  return readJson(file, null);
}

function cleanText(value, max = 1000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeDouyinUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/.test(url.protocol)) return "";
    if (!/(^|\.)douyin\.com$/i.test(url.hostname)) return "";
    return url.toString();
  } catch { return ""; }
}

function extractAwemeId(value) {
  const text = String(value || "");
  const patterns = [
    /\/(?:video|share\/video)\/(\d{8,})/i,
    /(?:modal_id|aweme_id|item_ids?|vid)=(\d{8,})/i,
    /\b(\d{15,22})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return "";
}

async function resolveDouyinLink(input) {
  const normalized = normalizeDouyinUrl(input);
  if (!normalized) throw new Error("请输入有效的抖音视频链接");
  const directId = extractAwemeId(normalized);
  if (directId) return { inputUrl: normalized, resolvedUrl: normalized, awemeId: directId };

  let response;
  try {
    response = await fetch(normalized, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`抖音短链接解析失败：${error.message}`);
  }
  const finalUrl = response.url || normalized;
  const finalId = extractAwemeId(finalUrl);
  if (finalId) return { inputUrl: normalized, resolvedUrl: finalUrl, awemeId: finalId };
  const body = (await response.text()).slice(0, 500_000);
  const bodyId = extractAwemeId(body);
  if (bodyId) return { inputUrl: normalized, resolvedUrl: finalUrl, awemeId: bodyId };
  throw new Error("无法从这个抖音链接识别作品 ID，请使用作品详情页链接或分享短链接");
}

function arkSettings() {
  const settings = videoInsightSettings();
  const secretsPath = path.join(dataDir, "video-insight-secrets.json");
  const secret = readJson(secretsPath, {});
  return { ...settings, apiKey: String(secret.apiKey || "").trim() };
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.output)) return payload.output.flatMap((item) => item?.content || [])
    .map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "")
    .filter(Boolean).join("");
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item?.text || item?.content || "").join("");
  return "";
}

function commentPrompt(comments) {
  const rows = comments.map((item, index) => `${index + 1}. [赞 ${item.likeCount || 0}] ${item.commentText}`).join("\n");
  return `你是用户需求研究员。请只根据下面的抖音公开评论，归纳观众真实关注点，不要把博主视频内容当成评论需求，不要编造评论没有表达的需求。\n\n只输出合法 JSON：\n{\n  "summary":"评论区整体需求判断",\n  "themes":[{"name":"需求主题","signal":"大家具体在关注什么","evidenceCount":3,"representativeComments":["原评论"]}],\n  "commonQuestions":["重复出现的问题"],\n  "painPoints":["明确表达的痛点"],\n  "purchaseOrCooperationSignals":["可能形成咨询、购买、合作或项目机会的信号"],\n  "highValueNeeds":["值得进一步验证的具体需求"],\n  "sentiment":"整体情绪",\n  "limitations":["样本限制"]\n}\n\n公开评论样本（共 ${comments.length} 条）：\n${rows}`;
}

function arkUsage(payload) {
  const usage = payload?.usage || {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  return { inputTokens, outputTokens, totalTokens: Number(usage.total_tokens ?? inputTokens + outputTokens) };
}

async function summarizeComments(comments) {
  const settings = arkSettings();
  if (!comments.length) return { summary: "暂未采集到公开评论，无法判断评论区普遍需求。", themes: [], commonQuestions: [], painPoints: [], purchaseOrCooperationSignals: [], highValueNeeds: [], sentiment: "无样本", limitations: ["当前作品没有可用公开评论样本"] };
  if (!settings.apiKey) throw new Error("已采集评论，但未配置火山方舟 API Key，无法总结评论需求");
  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.modelId,
      input: [{ role: "user", content: [{ type: "input_text", text: commentPrompt(comments) }] }],
      thinking: { type: "disabled" },
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`评论需求总结失败：${payload?.error?.message || `HTTP ${response.status}`}`);
  const raw = extractResponseText(payload);
  const parsed = parseVideoAnalysisJson(raw);
  if (!parsed && raw.trim()) {
    return {
      summary: cleanText(raw, 3000), themes: [], commonQuestions: [], painPoints: [],
      purchaseOrCooperationSignals: [], highValueNeeds: [], sentiment: "待复核",
      limitations: ["评论模型未按约定返回 JSON，已保留原始总结文本；该结果需要人工复核。"],
      usage: arkUsage(payload), unstructuredFallback: true,
    };
  }
  if (!parsed) throw new Error("评论需求总结未返回可用文本");
  return {
    summary: cleanText(parsed.summary, 3000),
    themes: Array.isArray(parsed.themes) ? parsed.themes.map((theme) => ({
      name: cleanText(theme?.name, 120), signal: cleanText(theme?.signal, 500), evidenceCount: Number(theme?.evidenceCount || 0), representativeComments: Array.isArray(theme?.representativeComments) ? theme.representativeComments.map((item) => cleanText(item, 300)).filter(Boolean).slice(0, 3) : [],
    })).filter((theme) => theme.name).slice(0, 8) : [],
    commonQuestions: Array.isArray(parsed.commonQuestions) ? parsed.commonQuestions.map((item) => cleanText(item, 400)).filter(Boolean).slice(0, 12) : [],
    painPoints: Array.isArray(parsed.painPoints) ? parsed.painPoints.map((item) => cleanText(item, 400)).filter(Boolean).slice(0, 12) : [],
    purchaseOrCooperationSignals: Array.isArray(parsed.purchaseOrCooperationSignals) ? parsed.purchaseOrCooperationSignals.map((item) => cleanText(item, 400)).filter(Boolean).slice(0, 12) : [],
    highValueNeeds: Array.isArray(parsed.highValueNeeds) ? parsed.highValueNeeds.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 12) : [],
    sentiment: cleanText(parsed.sentiment, 200),
    limitations: Array.isArray(parsed.limitations) ? parsed.limitations.map((item) => cleanText(item, 300)).filter(Boolean).slice(0, 8) : [],
    usage: arkUsage(payload),
  };
}

function commentCountTotal(comments) {
  return comments.reduce((sum, item) => sum + (Number(item.likeCount) || 0), 0);
}

async function runAnalysis(jobId, input) {
  updateJob(jobId, { status: "running", stage: "resolve_link", message: "正在解析抖音链接" });
  const resolved = await resolveDouyinLink(input.url);
  applyTikHubSettings();

  updateJob(jobId, { stage: "fetch_video", message: "正在通过 TikHub 获取作品详情和视频直链" });
  const detailResponse = await fetchTikHubDouyinWorkDetail(resolved.awemeId, { retries: 1, timeoutMs: 45_000 });
  const detail = detailResponse.detail;
  if (!detail.videoUrl && !detail.videoUrls?.length) throw new Error("TikHub 已找到作品，但没有返回可供模型读取的视频直链");

  updateJob(jobId, { stage: "fetch_comments", message: "正在采集评论区公开评论" });
  const settings = mvpSettings();
  let commentsResponse;
  try {
    commentsResponse = await fetchTikHubDouyinWorkComments(resolved.awemeId, {
      count: Math.min(50, Math.max(1, Number(input.commentsLimit || settings.commentsLimit || 50))),
      timeoutMs: 40_000,
      retries: 1,
    });
  } catch (error) {
    commentsResponse = { comments: [], error: error.message };
  }
  const comments = commentsResponse.comments || [];

  updateJob(jobId, { stage: "understand_video", message: "正在调用火山方舟理解视频内容" });
  const videoResult = await analyzeDouyinContentVideo({
    id: `mvp-${jobId}`,
    platform: "douyin",
    platform_content_id: resolved.awemeId,
    account_name: detail.authorName || "",
    title: detail.title,
    content_text: detail.title,
    published_at: detail.publishedAt || "",
    video_source_url: detail.videoUrl || detail.videoUrls?.[0] || "",
    video_source_candidates: detail.videoUrls || [],
    video_source_captured_at: new Date().toISOString(),
    video_source_status: "resolved",
  }, { timeoutMs: 180_000 });

  updateJob(jobId, { stage: "summarize_comments", message: `已采集 ${comments.length} 条评论，正在归纳普遍需求` });
  const commentResult = await summarizeComments(comments);
  const result = {
    analyzedAt: new Date().toISOString(),
    inputUrl: resolved.inputUrl,
    resolvedUrl: resolved.resolvedUrl,
    work: {
      id: resolved.awemeId,
      title: detail.title,
      authorName: detail.authorName || "",
      publishedAt: detail.publishedAt || "",
      durationSeconds: detail.durationSeconds || 0,
      coverUrl: detail.coverUrl || "",
      likeCount: detail.likeCount || 0,
      commentCount: detail.commentCount || 0,
      shareCount: detail.shareCount || 0,
    },
    video: {
      ...videoResult.analysis,
      model: videoResult.model,
      usage: videoResult.usage,
      costCny: videoResult.costCny,
      latencyMs: videoResult.latencyMs,
    },
    comments: {
      count: comments.length,
      totalLikes: commentCountTotal(comments),
      sample: comments.slice(0, 20),
      collectionError: commentsResponse.error || "",
      ...commentResult,
    },
    limitations: [
      "视频文件只使用 TikHub 返回的临时直链，不下载、不保存到本地。",
      commentsResponse.error ? `评论采集受限：${commentsResponse.error}` : "评论为 TikHub 当前接口返回的公开样本，不等同于完整评论区。",
    ],
  };
  updateJob(jobId, { status: "completed", stage: "completed", message: "分析完成", result });
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("请求 JSON 格式不正确"); }
}

function serveStatic(request, response) {
  const requested = request.url === "/" ? "index.html" : request.url.replace(/^\//, "");
  const file = path.resolve(publicDir, requested.split("?")[0]);
  if (!file.startsWith(path.resolve(publicDir))) return jsonResponse(response, 403, { error: "Forbidden" });
  if (!existsSync(file)) return jsonResponse(response, 404, { error: "Not found" });
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
  response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  response.end(readFileSync(file));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/settings") return jsonResponse(response, 200, publicSettings());
    if (request.method === "GET" && url.pathname === "/api/health") return jsonResponse(response, 200, { app: "video-insight-mvp", ok: true, ready: Boolean(videoInsightSettings().apiKeyConfigured && process.env.TIKHUB_API_KEY) });
    if (request.method === "POST" && url.pathname === "/api/settings") {
      const input = await readBody(request);
      const current = mvpSettings();
      const ark = saveVideoInsightSettings({
        apiKey: input.arkApiKey || undefined,
        endpoint: input.endpoint || undefined,
        modelId: input.modelId || undefined,
      });
      writeJson(settingsPath, {
        ...current,
        tikhubApiKey: typeof input.tikhubApiKey === "string" && input.tikhubApiKey.trim() ? input.tikhubApiKey.trim() : current.tikhubApiKey || "",
        tikhubBaseUrl: cleanText(input.tikhubBaseUrl || current.tikhubBaseUrl || defaultMvpSettings.tikhubBaseUrl, 500),
        commentsLimit: Math.min(50, Math.max(1, Number(input.commentsLimit || current.commentsLimit || 50))),
      });
      applyTikHubSettings();
      return jsonResponse(response, 200, { settings: publicSettings(), ready: Boolean(ark.apiKeyConfigured && process.env.TIKHUB_API_KEY) });
    }
    if (request.method === "POST" && url.pathname === "/api/analyze") {
      const input = await readBody(request);
      if (!normalizeDouyinUrl(input.url)) return jsonResponse(response, 400, { error: "请输入有效的抖音视频链接" });
      if (!videoInsightSettings().apiKeyConfigured || !process.env.TIKHUB_API_KEY) return jsonResponse(response, 409, { error: "请先在设置中配置火山方舟和 TikHub API Key" });
      const id = randomUUID();
      writeJson(path.join(jobsDir, `${id}.json`), { id, status: "queued", stage: "queued", message: "任务已进入队列", createdAt: new Date().toISOString(), result: null });
      queueMicrotask(() => runAnalysis(id, input).catch((error) => updateJob(id, { status: "failed", stage: "failed", message: error.message, error: error.message })));
      return jsonResponse(response, 202, { jobId: id });
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const job = getJob(jobMatch[1]);
      return job ? jsonResponse(response, 200, job) : jsonResponse(response, 404, { error: "任务不存在" });
    }
    return serveStatic(request, response);
  } catch (error) {
    jsonResponse(response, Number(error.statusCode || 500), { error: error.message || "服务器错误" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Video insight MVP listening on http://127.0.0.1:${port}`);
});
