const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function fmtShort(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtMaybePercent(value) {
  if (value === null || value === undefined) return "N/A";
  return `${Number(value).toFixed(1)}%`;
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function envLabel(row = {}) {
  if (row.environment === "wsl") return `WSL ${row.distro || ""}`.trim();
  if (row.environment === "windows") return "Windows";
  return row.environment || "unknown";
}

function metric(label, value, detail) {
  return `<article class="metric">
    <div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    <div class="detail">${esc(detail || "")}</div>
  </article>`;
}

function renderMetrics(snapshot) {
  const today = snapshot.today || {};
  const limits = snapshot.limits || {};
  const active = snapshot.active_session || {};
  const burn = snapshot.burn_rate || {};
  const topProject = snapshot.top_projects?.[0] || {};
  $("metrics").innerHTML = [
    metric("Today Tokens", fmtShort(today.totalTokens), `${fmtNumber(today.totalTokens)} total`),
    metric("Primary Limit", fmtMaybePercent(limits.primary?.used_percent), limits.primary?.resets_at ? `resets ${limits.primary.resets_at}` : "no limit sample"),
    metric("Active Burn", `${fmtNumber(burn.tokens_per_minute_15m)} / min`, `${fmtShort(burn.tokens_15m)} tokens in 15m`),
    metric("Top Project", topProject.projectName || "N/A", `${fmtShort(topProject.totalTokens)} tokens | ${envLabel(topProject)}`),
  ].join("");

  $("meta").textContent = `${snapshot.confidence} | ${snapshot.generated_at} | latest ${active.displayName || active.sessionFile || "none"}`;
}

function drawTrend(snapshot) {
  const canvas = $("trend");
  const ctx = canvas.getContext("2d");
  const rows = snapshot.recent_days || [];
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  if (!rows.length) return;

  const pad = 36;
  const max = Math.max(...rows.map((row) => row.totalTokens || 0), 1);
  const step = (width - pad * 2) / rows.length;

  ctx.strokeStyle = "#d8d7d1";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad + ((height - pad * 2) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  rows.forEach((row, index) => {
    const barHeight = ((height - pad * 2) * row.totalTokens) / max;
    const x = pad + index * step + step * 0.18;
    const y = height - pad - barHeight;
    ctx.fillStyle = "#0f766e";
    ctx.fillRect(x, y, step * 0.56, barHeight);
    ctx.fillStyle = "#6b6d70";
    ctx.font = "18px ui-sans-serif";
    ctx.fillText(row.date.slice(5), x - 4, height - 10);
  });
}

function usageRow(title, detail, total, ratio = null) {
  const width = ratio == null ? "" : `<div class="bar-track"><div class="bar-fill" style="width: ${Math.max(0, Math.min(100, ratio * 100))}%"></div></div>`;
  return `<div class="row">
    <div>
      <strong>${esc(title)}</strong>
      <div class="detail">${esc(detail || "")}</div>
      ${width}
    </div>
    <div class="mono">${esc(total)}</div>
  </div>`;
}

function renderActive(snapshot) {
  const active = snapshot.active_session;
  const limits = snapshot.limits || {};
  const rows = [];
  if (active) {
    rows.push(usageRow(
      active.displayName || (active.is_active ? "Active Session" : "Latest Session"),
      `${active.projectName || "unknown"} | ${envLabel(active)} | idle ${active.idle_minutes ?? "?"}m`,
      fmtShort(active.totalTokens),
    ));
  }
  if (limits.primary) {
    rows.push(usageRow("Primary Limit", limits.primary.resets_at ? `resets ${limits.primary.resets_at}` : "", fmtMaybePercent(limits.primary.used_percent), Number(limits.primary.used_percent || 0) / 100));
  }
  if (limits.secondary) {
    rows.push(usageRow("Secondary Limit", limits.secondary.resets_at ? `resets ${limits.secondary.resets_at}` : "", fmtMaybePercent(limits.secondary.used_percent), Number(limits.secondary.used_percent || 0) / 100));
  }
  $("active").innerHTML = rows.join("") || `<div class="detail">No active data</div>`;
}

function renderProjects(snapshot) {
  const projects = snapshot.top_projects || [];
  const total = projects.reduce((sum, project) => sum + project.totalTokens, 0) || 1;
  $("projects").innerHTML = projects.map((project) => usageRow(
    project.projectName || "unknown",
    `${envLabel(project)} | ${project.projectPath || ""}`,
    fmtShort(project.totalTokens),
    project.totalTokens / total,
  )).join("");
}

function renderModels(snapshot) {
  const models = Object.entries(snapshot.models || {}).sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  const total = models.reduce((sum, [, usage]) => sum + usage.totalTokens, 0) || 1;
  $("models").innerHTML = models.map(([model, usage]) => usageRow(
    model,
    usage.isFallback ? "model inferred as unknown" : "",
    fmtShort(usage.totalTokens),
    usage.totalTokens / total,
  )).join("");
}

function renderSessions(snapshot) {
  $("sessions").innerHTML = (snapshot.top_sessions || []).map((session) => usageRow(
    session.displayName || session.sessionFile || session.sessionId,
    `${session.projectName || "unknown"} | ${envLabel(session)} | ${session.lastActivity || ""}`,
    fmtShort(session.totalTokens),
  )).join("");
}

async function refresh() {
  $("meta").textContent = "Refreshing local Codex usage...";
  const response = await fetch("/api/snapshot", { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  const snapshot = await response.json();
  renderMetrics(snapshot);
  drawTrend(snapshot);
  renderActive(snapshot);
  renderProjects(snapshot);
  renderModels(snapshot);
  renderSessions(snapshot);
}

$("refresh").addEventListener("click", () => refresh().catch((error) => {
  $("meta").textContent = error.message;
}));

refresh().catch((error) => {
  $("meta").textContent = error.message;
});
