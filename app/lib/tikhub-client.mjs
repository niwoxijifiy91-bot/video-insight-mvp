import { estimatedTikHubRequestCost, recordProviderUsage } from "./cost-ledger.mjs";

const DEFAULT_BASE_URL = "https://api.tikhub.io";

const endpoints = Object.freeze({
  douyin: {
    searchUsers: "/api/v1/douyin/search/fetch_user_search_v2",
    searchVideos: "/api/v1/douyin/search/fetch_video_search_v2",
    oneVideo: "/api/v1/douyin/app/v3/fetch_one_video_v2",
    profile: "/api/v1/douyin/app/v3/handler_user_profile",
    works: "/api/v1/douyin/app/v3/fetch_user_post_videos",
    comments: "/api/v1/douyin/app/v3/fetch_video_comments",
  },
  xiaohongshu: {
    searchUsers: "/api/v1/xiaohongshu/app_v2/search_users",
    profile: "/api/v1/xiaohongshu/app_v2/get_user_info",
    works: "/api/v1/xiaohongshu/app_v2/get_user_posted_notes",
    comments: "/api/v1/xiaohongshu/app_v2/get_note_comments",
  },
});

export class TikHubApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TikHubApiError";
    this.endpoint = details.endpoint ?? "";
    this.httpStatus = details.httpStatus ?? 0;
    this.code = details.code ?? 0;
  }
}

export function isTikHubConfigured() {
  return Boolean(String(process.env.TIKHUB_API_KEY ?? "").trim());
}

export function supportsTikHubPlatform(platform) {
  return platform === "douyin" || platform === "xiaohongshu";
}

function apiConfig() {
  const apiKey = String(process.env.TIKHUB_API_KEY ?? "").trim();
  if (!apiKey) throw new TikHubApiError("TikHub API Key 未配置");
  return {
    apiKey,
    baseUrl: String(process.env.TIKHUB_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
  };
}

async function requestTikHub(endpoint, options = {}) {
  const { apiKey, baseUrl } = apiConfig();
  const url = new URL(endpoint, `${baseUrl}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const retries = Math.max(0, Number(options.retries ?? 2));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(Number(options.timeoutMs ?? 30_000)),
    });
    let payload;
    try { payload = await response.json(); }
    catch {
      lastError = new TikHubApiError(`TikHub 返回了无法解析的响应（HTTP ${response.status}）`, { endpoint, httpStatus: response.status });
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
        continue;
      }
      throw lastError;
    }
    const code = Number(payload?.code ?? response.status);
    if (!response.ok || code !== 200) {
      const detail = payload?.detail;
      const message = payload?.message_zh
        || payload?.message
        || detail?.message_zh
        || detail?.message
        || (typeof detail === "string" ? detail : "")
        || `HTTP ${response.status}`;
      lastError = new TikHubApiError(`TikHub ${endpoint} 调用失败：${message}`, { endpoint, httpStatus: response.status, code });
      if (attempt < retries && (response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
        continue;
      }
      throw lastError;
    }
    const requestId = String(payload?.request_id ?? "");
    const estimatedCost = estimatedTikHubRequestCost();
    recordProviderUsage({
      provider: "tikhub",
      operation: endpoint,
      status: "success",
      requestId,
      costUsd: estimatedCost.costUsd,
      costCny: estimatedCost.costCny,
      latencyMs: Date.now() - startedAt,
    });
    return {
      data: payload?.data,
      requestId,
      endpoint,
    };
  }
  throw lastError;
}

function valueAt(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const part of path.split(".")) current = current?.[part];
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return undefined;
}

function findArray(value, keys, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return [];
  seen.add(value);
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findArray(child, keys, depth + 1, seen);
    if (found.length) return found;
  }
  return [];
}

function findObject(value, predicate, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = findObject(child, predicate, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  if (!normalized) return 0;
  const match = normalized.match(/^([\d.]+)\s*([万亿wWkKmM]?)$/);
  if (!match) return Number(normalized) || 0;
  const factors = { 万: 10_000, w: 10_000, W: 10_000, 亿: 100_000_000, k: 1_000, K: 1_000, m: 1_000_000, M: 1_000_000 };
  return Math.round(Number(match[1]) * (factors[match[2]] || 1));
}

function firstUrl(value) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) return value.map(firstUrl).find(Boolean) || "";
  if (value && typeof value === "object") return firstUrl(value.url_list || value.urlList || value.url || value.uri);
  return "";
}

function allUrls(value) {
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(allUrls);
  if (value && typeof value === "object") return allUrls(value.url_list || value.urlList || value.url || value.uri);
  return [];
}

function videoSourceUrls(video = {}) {
  return [...new Set([
    video.play_addr,
    video.play_addr_265,
    video.download_addr,
    video.play_addr_h264,
  ].flatMap(allUrls))];
}

function toIsoDate(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const numeric = Number(value);
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function normalizeAccountName(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function diceScore(left, right) {
  const a = normalizeAccountName(left);
  const b = normalizeAccountName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.94;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    if (pairs.get(pair)) {
      overlap += 1;
      pairs.set(pair, pairs.get(pair) - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

function userCandidate(value) {
  const root = value?.user_info || value?.user || value?.basic_info || value;
  return {
    raw: root,
    name: String(valueAt(root, ["nick_name", "nickname", "name", "user_name"]) ?? "").trim(),
    platformUserId: String(valueAt(root, ["sec_uid", "sec_user_id", "user_id", "userid", "id"]) ?? "").trim(),
    platformId: String(valueAt(root, ["unique_id", "short_id", "red_id", "redId", "account"]) ?? "").trim(),
  };
}

export function selectBestUserCandidate(account, values) {
  const targetName = String(account?.account_name ?? "");
  const targetId = normalizeAccountName(account?.platform_id);
  const candidates = values.map(userCandidate).filter((item) => item.name || item.platformUserId);
  const ranked = candidates.map((candidate, index) => {
    const idExact = Boolean(targetId && [candidate.platformId, candidate.platformUserId].some((value) => normalizeAccountName(value) === targetId));
    const nameScore = diceScore(targetName, candidate.name);
    return { ...candidate, score: idExact ? 1.05 : nameScore === 1 ? 1 : nameScore - index * 0.002 };
  }).sort((left, right) => right.score - left.score);
  return ranked[0] && ranked[0].score >= 0.72 ? ranked[0] : null;
}

function directPlatformUserId(account) {
  const recorded = String(account.platform_internal_id || account.tikhub_user_id || "").trim();
  if (recorded) return recorded;
  const platformId = String(account.platform_id || "").trim();
  if (account.platform === "douyin" && /^MS4/i.test(platformId)) return platformId;
  if (account.platform === "xiaohongshu" && /^[a-f0-9]{24}$/i.test(platformId)) return platformId;
  try {
    const pathname = new URL(account.profile_url).pathname;
    const match = pathname.match(/\/user\/(?:profile\/)?([^/]+)/i);
    const id = decodeURIComponent(match?.[1] || "");
    if (account.platform === "douyin" && /^MS4/i.test(id)) return id;
    if (account.platform === "xiaohongshu" && /^[a-f0-9]{24}$/i.test(id)) return id;
  } catch {}
  return "";
}

function profileMetric(profile, names, interactionLabel = "") {
  const direct = valueAt(profile, names);
  if (direct !== undefined) return asNumber(direct);
  if (!interactionLabel) return 0;
  const interactions = findArray(profile, ["interactions", "interaction_info", "interactionInfo"]);
  const item = interactions.find((entry) => String(entry?.name || entry?.label || entry?.type || "").includes(interactionLabel));
  return asNumber(item?.count || item?.value || item?.count_text);
}

function normalizeProfile(platform, data, fallback) {
  const profile = findObject(data, (value) => Boolean(value.nickname || value.nick_name) && Boolean(value.sec_uid || value.user_id || value.userid || value.id || value.red_id))
    || findObject(data, (value) => Boolean(value.nickname || value.nick_name))
    || fallback?.raw
    || {};
  const platformUserId = String(valueAt(profile, ["sec_uid", "sec_user_id", "user_id", "userid", "id"]) || fallback?.platformUserId || "");
  const platformId = String(valueAt(profile, ["unique_id", "short_id", "red_id", "redId", "account"]) || fallback?.platformId || "");
  const accountName = String(valueAt(profile, ["nickname", "nick_name", "name", "user_name"]) || fallback?.name || "");
  const verifiedValue = valueAt(profile, ["is_verified", "verified", "verification_type"]);
  const avatar = firstUrl(valueAt(profile, ["avatar_larger", "avatar_medium", "avatar_thumb", "avatar", "image", "images", "imageb"]));
  const profileUrl = platform === "douyin"
    ? `https://www.douyin.com/user/${encodeURIComponent(platformUserId)}`
    : `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(platformUserId)}`;
  return {
    platformUserId,
    platformId,
    accountName,
    profileUrl,
    avatarUrl: avatar,
    signature: String(valueAt(profile, ["signature", "desc", "description", "bio"]) || ""),
    followerCount: profileMetric(profile, ["follower_count", "fans_cnt", "fans_count", "fans"], "粉丝"),
    followingCount: profileMetric(profile, ["following_count", "follow_count", "follows"], "关注"),
    workCount: profileMetric(profile, ["aweme_count", "publish_cnt", "note_count", "notes_count", "ndiscovery", "note_num_stat.posted"], "笔记"),
    totalLikes: profileMetric(profile, ["total_favorited", "like_cnt", "liked_count", "liked", "likes"], "获赞"),
    totalCollected: profileMetric(profile, ["collected", "note_num_stat.collected"], "收藏"),
    location: String(valueAt(profile, ["ip_location", "location", "city"]) || ""),
    isVerified: verifiedValue === true || verifiedValue === 1 || verifiedValue === "1" || verifiedValue === "true",
    verificationReason: String(valueAt(profile, ["enterprise_verify_reason", "custom_verify", "verification_reason", "verify_info"]) || ""),
  };
}

function normalizeWork(platform, value) {
  const work = value?.aweme_info || value?.note_card || value?.note || value;
  const statistics = work?.statistics || work?.stats || work?.interact_info || work?.interactInfo || work;
  const video = work?.video || {};
  const id = String(valueAt(work, ["aweme_id", "note_id", "id", "item_id"]) || valueAt(value, ["aweme_id", "note_id", "id"]) || "");
  if (!id) return null;
  const title = String(valueAt(work, ["display_title", "title", "note_title", "desc"]) || "").replace(/\s+/g, " ").trim();
  const sourceUrl = platform === "douyin" ? `https://www.douyin.com/video/${id}` : `https://www.xiaohongshu.com/explore/${id}`;
  const videoUrls = platform === "douyin" ? videoSourceUrls(video) : [];
  return {
    platformContentId: id,
    title: title || "未命名作品",
    contentText: String(valueAt(work, ["desc", "description", "content", "display_title", "title"]) || title).trim(),
    sourceUrl,
    videoUrl: videoUrls[0] || "",
    videoUrls,
    publishedAt: toIsoDate(valueAt(work, ["create_time", "createTime", "time", "publish_time", "publishTime"])),
    likeCount: asNumber(valueAt(statistics, ["digg_count", "liked_count", "like_count", "likedCount", "likes"])),
    commentCount: asNumber(valueAt(statistics, ["comment_count", "comments_count", "comments", "commentCount"])),
    collectCount: asNumber(valueAt(statistics, ["collect_count", "collected_count", "collectedCount"])),
    shareCount: asNumber(valueAt(statistics, ["share_count", "shareCount"])),
    viewCount: asNumber(valueAt(statistics, ["play_count", "view_count", "viewCount"])),
  };
}

function parseJsonObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeContactSheet(value) {
  const url = firstUrl(value?.img_url || value?.img_urls || value?.url_list || value);
  if (!url) return null;
  const columns = Math.max(0, Math.round(asNumber(value?.img_x_len || value?.columns)));
  const rows = Math.max(0, Math.round(asNumber(value?.img_y_len || value?.rows)));
  return {
    url,
    frameCount: Math.max(0, Math.round(asNumber(value?.img_num || value?.frame_count || columns * rows))),
    intervalSeconds: Number(value?.interval || value?.interval_seconds || 0) || 0,
    columns,
    rows,
    tileWidth: Math.max(0, Math.round(asNumber(value?.img_x_size || value?.tile_width))),
    tileHeight: Math.max(0, Math.round(asNumber(value?.img_y_size || value?.tile_height))),
    durationSeconds: Number(value?.duration || value?.duration_seconds || 0) || 0,
  };
}

export function normalizeDouyinWorkDetail(data) {
  const aweme = data?.aweme_detail
    || findObject(data, (value) => Boolean(value.aweme_id) && Boolean(value.video))
    || {};
  const video = aweme.video || {};
  const videoModel = parseJsonObject(video.video_model);
  const contactSheetValues = [
    ...(Array.isArray(video.big_thumbs) ? video.big_thumbs : []),
    ...(Array.isArray(videoModel.big_thumbs) ? videoModel.big_thumbs : []),
  ];
  const seen = new Set();
  const contactSheets = contactSheetValues
    .map(normalizeContactSheet)
    .filter((item) => item && !seen.has(item.url) && seen.add(item.url));
  const durationMillis = Number(video.duration || aweme.duration || 0);
  const durationSeconds = durationMillis > 10_000 ? durationMillis / 1000 : durationMillis;
  const videoUrls = videoSourceUrls(video);
  return {
    platformContentId: String(aweme.aweme_id || ""),
    title: String(aweme.desc || "").trim(),
    durationSeconds: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 10) / 10 : 0,
    coverUrl: firstUrl(video.cover || video.origin_cover || video.dynamic_cover),
    videoUrl: videoUrls[0] || "",
    videoUrls,
    contactSheets,
    hasEmbeddedSubtitle: Boolean(videoModel.has_embedded_subtitle),
  };
}

function normalizeComment(value) {
  const comment = value?.comment || value;
  const text = String(valueAt(comment, ["text", "content", "comment_text", "note_comment"]) || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const author = comment?.user || comment?.author || comment?.user_info || {};
  return {
    platformCommentId: String(valueAt(comment, ["cid", "comment_id", "id"]) || ""),
    commentText: text,
    authorName: String(valueAt(author, ["nickname", "nick_name", "name"]) || "公开评论用户"),
    likeCount: asNumber(valueAt(comment, ["digg_count", "like_count", "likeCount", "liked_count", "likes"])),
    publishedAt: toIsoDate(valueAt(comment, ["create_time", "createTime", "time", "publish_time"])),
  };
}

function inRequestedWindow(value, options) {
  if (!value) return false;
  const millis = new Date(value).getTime();
  if (!Number.isFinite(millis)) return false;
  const start = new Date(options.startAt || Date.now() - Math.max(1, Number(options.freshnessWindowDays || 7)) * 86_400_000).getTime();
  const end = new Date(options.endAt || Date.now()).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && millis >= start && millis < end;
}

async function resolveUser(account, trace) {
  const directId = directPlatformUserId(account);
  if (directId) return { platformUserId: directId, name: account.account_name, platformId: account.platform_id || "", score: 1, raw: {} };
  if (account.platform === "douyin") {
    const result = await requestTikHub(endpoints.douyin.searchUsers, {
      method: "POST",
      body: { keyword: account.account_name, cursor: 0 },
    });
    trace.push({ endpoint: result.endpoint, requestId: result.requestId });
    const users = findArray(result.data, ["user_list", "users"]);
    const selected = selectBestUserCandidate(account, users);
    if (!selected) throw new TikHubApiError(`TikHub 未找到与“${account.account_name}”足够匹配的抖音账号`, { endpoint: endpoints.douyin.searchUsers });
    return selected;
  }
  const result = await requestTikHub(endpoints.xiaohongshu.searchUsers, {
    query: { keyword: account.account_name, page: 1 },
  });
  trace.push({ endpoint: result.endpoint, requestId: result.requestId });
  const users = findArray(result.data, ["users", "user_list", "items"]);
  const selected = selectBestUserCandidate(account, users);
  if (!selected) throw new TikHubApiError(`TikHub 未找到与“${account.account_name}”足够匹配的小红书账号`, { endpoint: endpoints.xiaohongshu.searchUsers });
  return selected;
}

export async function collectTikHubAccount(account, options = {}) {
  if (!supportsTikHubPlatform(account.platform)) throw new TikHubApiError(`TikHub 暂未接入平台：${account.platform}`);
  const platformEndpoints = endpoints[account.platform];
  const trace = [];
  const errors = [];
  const resolved = await resolveUser(account, trace);
  let profileData;
  try {
    const result = await requestTikHub(platformEndpoints.profile, {
      query: account.platform === "douyin" ? { sec_user_id: resolved.platformUserId } : { user_id: resolved.platformUserId },
    });
    trace.push({ endpoint: result.endpoint, requestId: result.requestId });
    profileData = result.data;
  } catch (error) {
    errors.push(error.message);
  }
  const profile = normalizeProfile(account.platform, profileData, resolved);
  if (!profile.platformUserId) throw new TikHubApiError(`TikHub 无法解析“${account.account_name}”的平台用户 ID`);

  let works = [];
  try {
    const result = await requestTikHub(platformEndpoints.works, {
      query: account.platform === "douyin"
        ? { sec_user_id: profile.platformUserId, max_cursor: 0, count: 20, sort_type: 0 }
        : { user_id: profile.platformUserId },
    });
    trace.push({ endpoint: result.endpoint, requestId: result.requestId });
    works = findArray(result.data, account.platform === "douyin" ? ["aweme_list", "awemeList", "items"] : ["notes", "note_list", "items"])
      .map((item) => normalizeWork(account.platform, item))
      .filter(Boolean);
  } catch (error) {
    errors.push(error.message);
  }

  const maxWorks = Math.max(0, Number(options.maxWorksPerAccount || 5));
  const maxComments = Math.max(0, Number(options.maxCommentsPerWork || 20));
  works = works.filter((work) => inRequestedWindow(work.publishedAt, options));
  if (works.length && typeof options.onWorks === "function") {
    await options.onWorks({ works, profile, collectionWindow: { startAt: options.startAt || "", endAt: options.endAt || "" } });
  }
  const commentTargets = works.slice(0, maxWorks);
  for (const work of commentTargets) {
    try {
      const result = await requestTikHub(platformEndpoints.comments, {
        query: account.platform === "douyin"
          ? { aweme_id: work.platformContentId, cursor: 0, count: Math.min(20, maxComments) }
          : { note_id: work.platformContentId, index: 0, sort_strategy: "latest_v2" },
      });
      trace.push({ endpoint: result.endpoint, requestId: result.requestId });
      work.comments = findArray(result.data, ["comments", "comment_list", "items"])
        .map(normalizeComment)
        .filter((comment) => comment && inRequestedWindow(comment.publishedAt, options))
        .slice(0, maxComments);
    } catch (error) {
      work.comments = [];
      errors.push(error.message);
    }
  }

  return {
    provider: "tikhub",
    matchScore: resolved.score,
    profile,
    works,
    collectionWindow: {
      startAt: options.startAt || "",
      endAt: options.endAt || "",
    },
    errors,
    trace,
  };
}

export async function fetchTikHubDouyinWorkComments(platformContentId, options = {}) {
  const workId = String(platformContentId ?? "").trim();
  if (!workId) throw new TikHubApiError("抖音作品 ID 不能为空");
  const count = Math.min(50, Math.max(1, Number(options.count || 20)));
  const result = await requestTikHub(endpoints.douyin.comments, {
    query: { aweme_id: workId, cursor: Number(options.cursor || 0), count },
    timeoutMs: options.timeoutMs,
  });
  const comments = findArray(result.data, ["comments", "comment_list", "items"])
    .map(normalizeComment)
    .filter(Boolean)
    .filter((comment) => !options.startAt || inRequestedWindow(comment.publishedAt, options))
    .slice(0, count);
  return { comments, requestId: result.requestId, endpoint: result.endpoint };
}

export async function fetchTikHubDouyinUserWorks(platformUserId, options = {}) {
  const userId = String(platformUserId ?? "").trim();
  if (!userId) throw new TikHubApiError("抖音 sec_user_id 不能为空");
  const result = await requestTikHub(endpoints.douyin.works, {
    query: {
      sec_user_id: userId,
      max_cursor: 0,
      count: Math.min(20, Math.max(1, Number(options.count || 20))),
      sort_type: 0,
    },
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  const works = findArray(result.data, ["aweme_list", "awemeList", "items"])
    .map((item) => normalizeWork("douyin", item))
    .filter(Boolean)
    .filter((work) => inRequestedWindow(work.publishedAt, options));
  return { works, requestId: result.requestId, endpoint: result.endpoint };
}

export async function fetchTikHubDouyinWorkDetail(platformContentId, options = {}) {
  const workId = String(platformContentId ?? "").trim();
  if (!workId) throw new TikHubApiError("抖音作品 ID 不能为空");
  const result = await requestTikHub(endpoints.douyin.oneVideo, {
    query: { aweme_id: workId },
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  const detail = normalizeDouyinWorkDetail(result.data);
  if (!detail.platformContentId) throw new TikHubApiError("TikHub 返回的抖音作品详情无法解析", { endpoint: result.endpoint });
  return { detail, requestId: result.requestId, endpoint: result.endpoint };
}

export async function searchTikHubDouyinCreators(keyword, options = {}) {
  const normalizedKeyword = String(keyword ?? "").trim();
  if (!normalizedKeyword) throw new TikHubApiError("Douyin search keyword is required");
  const result = await requestTikHub(endpoints.douyin.searchVideos, {
    method: "POST",
    body: {
      keyword: normalizedKeyword,
      cursor: Number(options.cursor || 0),
      sort_type: String(options.sortType ?? "0"),
      publish_time: String(options.publishTime ?? "7"),
      filter_duration: String(options.filterDuration ?? "0"),
      content_type: String(options.contentType ?? "0"),
      search_id: String(options.searchId ?? ""),
      backtrace: String(options.backtrace ?? ""),
    },
    timeoutMs: options.timeoutMs,
  });
  const rows = findArray(result.data, ["business_data"]);
  const creators = [];
  const seen = new Set();
  for (const row of rows) {
    const workValue = row?.data?.aweme_info || row?.aweme_info || row?.data;
    const author = workValue?.author || workValue?.author_user_info;
    if (!workValue || !author) continue;
    const profile = normalizeProfile("douyin", { user: author }, userCandidate(author));
    const work = normalizeWork("douyin", workValue);
    if (!profile.platformUserId || !profile.accountName || !work || seen.has(profile.platformUserId)) continue;
    seen.add(profile.platformUserId);
    creators.push({ profile, work });
  }
  const pageState = findObject(result.data, (value) => ("cursor" in value || "has_more" in value) && ("business_data" in value || "search_id" in value)) || result.data || {};
  return {
    keyword: normalizedKeyword,
    requestId: result.requestId,
    creators,
    nextCursor: Number(valueAt(pageState, ["cursor", "next_cursor", "nextCursor"]) || 0),
    hasMore: Boolean(valueAt(pageState, ["has_more", "hasMore"])),
    searchId: String(valueAt(pageState, ["search_id", "searchId"]) || options.searchId || ""),
    backtrace: String(valueAt(pageState, ["backtrace"]) || options.backtrace || ""),
  };
}

export const tikHubEndpoints = endpoints;
