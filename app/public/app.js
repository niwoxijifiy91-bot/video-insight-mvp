const $ = (selector) => document.querySelector(selector);
const state = { settings: null, jobId: "", timer: null };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char]));
}

function list(items, empty = "暂无") {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  return rows.length ? `<ul class="mini-list">${rows.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="field-hint">${empty}</p>`;
}

function tags(items) {
  return (Array.isArray(items) ? items : []).filter(Boolean).map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("");
}

function setPipeline(stage) {
  const order = { resolve_link: 0, fetch_video: 0, fetch_comments: 1, understand_video: 1, summarize_comments: 2, completed: 2 };
  const active = order[stage] ?? 0;
  document.querySelectorAll(".pipeline-item").forEach((item, index) => item.classList.toggle("active", index === active));
  document.querySelectorAll(".pipeline-item").forEach((item, index) => item.classList.toggle("done", index < active));
}

function renderResult(result) {
  const video = result.video || {};
  const comments = result.comments || {};
  const work = result.work || {};
  const evidence = Array.isArray(video.evidence) ? video.evidence : [];
  const themes = Array.isArray(comments.themes) ? comments.themes : [];
  const samples = Array.isArray(comments.sample) ? comments.sample : [];
  const business = video.business_signals || {};
  $("#resultContent").innerHTML = `<div class="result-content">
    <header class="result-header"><div><p class="result-label">ANALYSIS COMPLETE</p><h2>${escapeHtml(video.title || work.title || "未命名作品")}</h2><p class="result-meta">${escapeHtml(work.authorName || "抖音作品")} · ${escapeHtml(work.publishedAt || "发布时间未返回")} · ${escapeHtml(String(work.durationSeconds || 0))} 秒</p></div><div class="score-box"><b>${escapeHtml(video.confidence || 0)}</b><span>内容置信度</span></div></header>
    <section class="result-block"><h3>视频讲了什么</h3><p class="summary">${escapeHtml(video.summary || video.one_sentence || "暂无视频总结")}</p><div class="tag-row">${tags([video.primary_topic, ...(video.tools_or_models || []), ...(video.topics || [])])}</div></section>
    <section class="result-block two-col"><div><h3>核心知识点</h3>${list(video.knowledge_points)}</div><div><h3>博主主张与展示</h3>${list([...(video.creator_claims || []), ...(video.demonstrated_steps || [])])}</div></section>
    <section class="result-block"><h3>视频结构</h3><div class="two-col"><div><p><strong>开头钩子</strong><br>${escapeHtml(video.structure?.opening_hook || "暂无")}</p><p><strong>结构概括</strong><br>${escapeHtml(video.structure?.structure_summary || "暂无")}</p></div><div><p><strong>节奏与留存</strong><br>${escapeHtml(video.structure?.pacing || "暂无")}</p>${list(video.structure?.retention_devices, "暂无留存机制记录")}</div></div>${evidence.length ? `<div class="evidence-list">${evidence.slice(0, 10).map((item) => `<div class="evidence-item"><time>${escapeHtml(item.time_range || "时间未标注")}</time><p>${escapeHtml(item.observation)} <small>${escapeHtml(item.modality || "视频证据")}</small></p></div>`).join("")}</div>` : ""}</section>
    <section class="result-block"><h3>商业与执行信号</h3><div class="two-col"><div>${list([business.cost && `成本：${business.cost}`, business.efficiency && `效率：${business.efficiency}`, business.commercialization && `商业化：${business.commercialization}`])}</div><div>${list([business.implementation_barrier && `落地障碍：${business.implementation_barrier}`, business.feasibility && `可行性：${business.feasibility}`, video.call_to_action && `行动引导：${video.call_to_action}`])}</div></div></section>
    <section class="result-block"><div class="comment-head"><h3>评论区普遍需求</h3><span class="comment-count">采集 ${escapeHtml(comments.count || 0)} 条 · ${escapeHtml(comments.sentiment || "情绪未判断")}</span></div><p class="summary">${escapeHtml(comments.summary || "暂无评论需求总结")}</p>${themes.length ? `<div class="theme-grid">${themes.map((theme) => `<article class="theme-card"><h4>${escapeHtml(theme.name)} <small>${escapeHtml(theme.evidenceCount || 0)} 条信号</small></h4><p>${escapeHtml(theme.signal)}</p>${theme.representativeComments?.[0] ? `<blockquote>“${escapeHtml(theme.representativeComments[0])}”</blockquote>` : ""}</article>`).join("")}</div>` : ""}</section>
    <section class="result-block two-col"><div><h3>高价值需求</h3>${list(comments.highValueNeeds)}</div><div><h3>重复问题与痛点</h3>${list([...(comments.commonQuestions || []), ...(comments.painPoints || [])])}</div></section>
    <section class="result-block"><h3>评论样本</h3><div class="comment-samples">${samples.length ? samples.map((item) => `<div class="comment-sample">${escapeHtml(item.commentText)} <span>赞 ${escapeHtml(item.likeCount || 0)}</span></div>`).join("") : `<p class="field-hint">没有可展示的评论样本</p>`}</div></section>
    ${result.limitations?.length ? `<div class="notice">${result.limitations.map((item) => escapeHtml(item)).join("<br>")}</div>` : ""}
  </div>`;
  $("#emptyState").classList.add("hidden"); $("#loadingState").classList.add("hidden"); $("#resultContent").classList.remove("hidden");
}

async function loadSettings() {
  const response = await fetch("/api/settings"); state.settings = await response.json();
  const ready = state.settings.arkApiKeyConfigured && state.settings.tikhubApiKeyConfigured;
  $("#providerStatus").textContent = ready ? "接口已就绪" : "需要配置接口";
  $("#providerStatus").className = `status-pill ${ready ? "" : "warn"}`;
  $("#setupNotice").classList.toggle("hidden", ready);
}

function fillSettings() {
  const settings = state.settings || {};
  $("#modelId").value = settings.modelId || ""; $("#endpoint").value = settings.endpoint || "";
  $("#tikhubBaseUrl").value = settings.tikhubBaseUrl || ""; $("#commentsLimitSetting").value = String(settings.commentsLimit || 50);
  $("#arkApiKey").value = ""; $("#tikhubApiKey").value = "";
}

async function pollJob() {
  const response = await fetch(`/api/jobs/${state.jobId}`); const job = await response.json();
  setPipeline(job.stage); $("#loadingMessage").textContent = job.message || "任务处理中";
  if (job.status === "completed") { clearInterval(state.timer); renderResult(job.result); $("#analyzeButton").disabled = false; return; }
  if (job.status === "failed") { clearInterval(state.timer); $("#loadingState").classList.add("hidden"); $("#resultContent").classList.remove("hidden"); $("#resultContent").innerHTML = `<div class="error-box"><strong>分析未完成</strong><p>${escapeHtml(job.error || job.message || "未知错误")}</p></div>`; $("#analyzeButton").disabled = false; }
}

$("#settingsButton").addEventListener("click", async () => { await loadSettings(); fillSettings(); $("#settingsDialog").showModal(); });
$("#setupNoticeButton").addEventListener("click", async () => { await loadSettings(); fillSettings(); $("#settingsDialog").showModal(); });
$("#closeSettings").addEventListener("click", () => $("#settingsDialog").close());
$("#settingsForm").addEventListener("submit", async (event) => { event.preventDefault(); const payload = { arkApiKey: $("#arkApiKey").value, modelId: $("#modelId").value, endpoint: $("#endpoint").value, tikhubApiKey: $("#tikhubApiKey").value, tikhubBaseUrl: $("#tikhubBaseUrl").value, commentsLimit: $("#commentsLimitSetting").value }; const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); const data = await response.json(); $("#settingsMessage").textContent = response.ok ? "设置已保存在本机" : data.error || "保存失败"; if (response.ok) { await loadSettings(); setTimeout(() => $("#settingsDialog").close(), 500); } });
$("#analysisForm").addEventListener("submit", async (event) => { event.preventDefault(); const url = $("#videoUrl").value.trim(); if (!url) return; $("#emptyState").classList.add("hidden"); $("#resultContent").classList.add("hidden"); $("#loadingState").classList.remove("hidden"); $("#analyzeButton").disabled = true; setPipeline("resolve_link"); const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, commentsLimit: $("#commentsLimit").value }) }); const data = await response.json(); if (!response.ok) { $("#loadingState").classList.add("hidden"); $("#resultContent").classList.remove("hidden"); $("#resultContent").innerHTML = `<div class="error-box"><strong>无法开始分析</strong><p>${escapeHtml(data.error || "请求失败")}</p></div>`; $("#analyzeButton").disabled = false; return; } state.jobId = data.jobId; clearInterval(state.timer); state.timer = setInterval(pollJob, 1200); pollJob(); });
loadSettings();
