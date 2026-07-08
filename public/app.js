const $ = (id) => document.getElementById(id);

/* ── Helpers ─────────────────────────────── */

function toast(msg, kind = "info") {
  const el = document.createElement("div");
  const bg = kind === "success" ? "#22c55e" : kind === "error" ? "#ef4444" : "#3b82f6";
  Object.assign(el.style, {
    position: "fixed", bottom: "20px", right: "20px", zIndex: "999",
    background: bg, color: "#fff", padding: "10px 20px", borderRadius: "8px",
    fontFamily: "var(--font-sans)", fontSize: "13px", fontWeight: "600",
    boxShadow: "0 4px 16px rgba(0,0,0,0.5)", transition: "opacity 0.3s",
    opacity: "1", maxWidth: "400px",
  });
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 3000);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;",
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

function fmtPercent(value) {
  if (value === null || value === undefined) return "N/A";
  return `${Number(value).toFixed(1)}%`;
}

function fmtCompactTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.round((now - d) / 60000);
  // Future date — show countdown
  if (diffMin < 0) {
    const remaining = Math.abs(diffMin);
    if (remaining < 60) return `in ${remaining}m`;
    const remainingH = Math.round(remaining / 60);
    if (remainingH < 48) return `in ${remainingH}h`;
    const remainingD = Math.round(remaining / 1440);
    return `in ${remainingD}d`;
  }
  // Past date — show elapsed
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function envLabel(row = {}) {
  if (row.environment === "wsl") return `WSL ${row.distro || ""}`.trim();
  if (row.environment === "windows") return "Windows";
  return row.environment || "unknown";
}

/* ── Status helpers ──────────────────────── */

function limitBadge(usedPercent) {
  const p = Number(usedPercent || 0);
  if (p >= 100) return "hit";
  if (p >= 90) return "near";
  return "ok";
}

function sessionBadge(session) {
  if (!session) return null;
  if (session.is_active) return "active";
  return "idle";
}

/* ── Components ──────────────────────────── */

function metricCard(label, value, detail, opts = {}) {
  const cls = opts.accent || "";
  return `<article class="metric">
    <div class="metric-label">${esc(label)}</div>
    <div class="metric-value ${cls}">${esc(value)}</div>
    ${detail ? `<div class="metric-detail">${esc(detail)}</div>` : ""}
  </article>`;
}

function usageRow(title, detail, value, opts = {}) {
  const bar = opts.ratio != null
    ? `<div class="bar-track"><div class="bar-fill${opts.barClass ? ` ${opts.barClass}` : ""}" style="width:${Math.max(0, Math.min(100, opts.ratio * 100))}%"></div></div>`
    : "";
  const badge = opts.badge
    ? ` <span class="badge badge-${esc(opts.badge)}">${esc(opts.badge)}</span>`
    : "";
  return `<div class="row">
    <div>
      <div class="row-title">${esc(title)}${badge}</div>
      ${detail ? `<div class="row-detail">${esc(detail)}</div>` : ""}
      ${bar}
    </div>
    <div class="row-value">${esc(value)}</div>
  </div>`;
}

function emptyState(message) {
  return `<div class="empty">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
    <p>${esc(message)}</p>
  </div>`;
}

/* ── Render: Key Metrics ─────────────────── */

function renderMetrics(snapshot) {
  const today = snapshot.today || {};
  const limits = snapshot.limits || {};
  const burn = snapshot.burn_rate || {};
  const topProject = snapshot.top_projects?.[0] || {};
  const active = snapshot.active_session || {};

  const primaryPct = limits.primary?.used_percent;
  const primaryClass = primaryPct != null && primaryPct >= 90 ? "warn" : "";

  // Cache hit rate
  const cacheTotal = (today.cacheReadTokens || 0) + (today.inputTokens || 0);
  const cacheRate = cacheTotal > 0 ? Math.round((today.cacheReadTokens || 0) / cacheTotal * 100) : null;

  const items = [
    metricCard("Today Tokens", fmtShort(today.totalTokens),
      `${fmtNumber(today.totalTokens)} total · ${today.eventCount || 0} events`,
      { accent: "accent" }),
    metricCard("Cache Hit Rate", cacheRate != null ? `${cacheRate}%` : "N/A",
      `${fmtShort(today.cacheReadTokens || 0)} cached · ${fmtShort(today.inputTokens || 0)} new`,
      { accent: cacheRate != null && cacheRate >= 80 ? "accent" : "" }),
    metricCard("Primary Limit", fmtPercent(primaryPct),
      limits.primary?.resets_at ? `Resets ${fmtCompactTime(limits.primary.resets_at)}` : "No sample",
      { accent: primaryClass }),
    metricCard("Active Session", active.displayName || "None",
      `${active.projectName || ""} · ${envLabel(active)} · idle ${active.idle_minutes ?? "?"}m`,
      {}),
  ];

  $("metrics").innerHTML = items.join("");

  // Source status badges (hour-precise)
  const ss = snapshot.source_status || {};
  function sourceBadge(name, info) {
    if (!info || info.status === "unknown") return `<span class="badge badge-idle" title="No data">${name}: ?</span>`;
    // status → color + label
    const cls =
      info.status === "active" ? "badge-active"   // green: <1h
      : info.status === "recent" ? "badge-active"  // green: <24h
      : info.status === "idle" ? "badge-idle"      // yellow: <48h
      : info.status === "stale" ? "badge-near"     // orange: <7d
      : "badge-hit";                                // red: >7d expired
    const label =
      info.status === "active" ? `${name}: active`
      : info.status === "recent" ? `${name}: active`
      : info.status === "idle" ? `${name}: idle`
      : info.status === "stale" ? `${name}: ⚠ stale`
      : `${name}: ⚠ expired`;
    const hours = info.hours_since_last;
    const ago = hours != null
      ? hours < 1 ? "just now" : hours < 24 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`
      : "never";
    const todayInfo = info.today_tokens > 0 ? ` · today ${fmtShort(info.today_tokens)} tokens` : "";
    return `<span class="badge ${cls}" title="last seen ${ago}${todayInfo}">${label}</span>`;
  }
  const badges = `${sourceBadge("Codex", ss.codex)} ${sourceBadge("Claude", ss.claude)}`;

  $("meta").innerHTML = `${badges} <span style="margin-left:8px;color:#64748b;font-size:12px">· ${snapshot.generated_at}</span>`;
  $("footer-stats").textContent = `${snapshot.totals?.eventCount || snapshot.diagnostics?.events_read || 0} API calls · ${snapshot.diagnostics?.files_read || 0} files`;
}

/* ── Render: Chart ───────────────────────── */

const TOKEN_COLOR = "#22c55e";
const TOKEN_COLOR_DIM = "#16a34a";
const TOKEN_COLOR_HL = "#4ade80";
const REQUEST_COLOR = "#3b82f6";
const REQUEST_COLOR_HL = "#60a5fa";
const REQUEST_COLOR_GLOW = "rgba(59, 130, 246, 0.15)";

// Animation state for trend chart
let trendPrevBars = null;
let trendAnimStart = 0;
let trendAnimId = null;
const TREND_ANIM_DURATION = 300;

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function drawTrend(snapshot) {
  const canvas = $("trend");
  const ctx = canvas.getContext("2d");
  const tooltip = $("chartTooltip");
  const rows = (snapshot.recent_days || []).slice(-30);
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  if (!rows.length) return;

  const pad = { top: 28, right: 56, bottom: 32, left: 60 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const step = chartW / rows.length;

  const tokenMax = Math.max(...rows.map((r) => r.totalTokens || 0), 1);
  const requestMax = Math.max(...rows.map((r) => r.eventCount || 0), 1);

  // Build hit-test regions
  const bars = rows.map((row, i) => {
    const barW = Math.max(4, step * 0.55);
    return {
      x: pad.left + i * step + (step - barW) / 2,
      y: pad.top + chartH - Math.max(2, (chartH * (row.totalTokens || 0)) / tokenMax),
      w: barW,
      h: Math.max(2, (chartH * (row.totalTokens || 0)) / tokenMax),
      date: row.date,
      tokens: row.totalTokens || 0,
      requests: row.eventCount || 0,
    };
  });

  const hitData = { bars, pad, step, chartW, chartH, tokenMax, requestMax, W, H };

  function draw(highlightIndex) {
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = "#0b1120";
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = pad.top + (chartH * i) / gridLines;
      ctx.strokeStyle = "#1e293b";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, Math.round(y) + 0.5);
      ctx.lineTo(W - pad.right, Math.round(y) + 0.5);
      ctx.stroke();

      // Left Y-axis: tokens
      const tokenVal = tokenMax - (tokenMax * i) / gridLines;
      ctx.fillStyle = TOKEN_COLOR;
      ctx.font = "10px 'Fira Code', ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(fmtShort(tokenVal), pad.left - 8, Math.round(y));

      // Right Y-axis: requests
      const reqVal = requestMax - (requestMax * i) / gridLines;
      ctx.fillStyle = REQUEST_COLOR;
      ctx.textAlign = "left";
      ctx.fillText(fmtShort(reqVal), W - pad.right + 8, Math.round(y));
    }

    // Bars
    bars.forEach((bar, i) => {
      const isHL = highlightIndex === i;
      const grad = ctx.createLinearGradient(bar.x, bar.y, bar.x, pad.top + chartH);
      grad.addColorStop(0, isHL ? TOKEN_COLOR_HL : TOKEN_COLOR);
      grad.addColorStop(1, isHL ? "#22c55e" : TOKEN_COLOR_DIM);
      ctx.fillStyle = grad;

      const r = Math.min(3, bar.w / 2);
      ctx.beginPath();
      ctx.moveTo(bar.x, pad.top + chartH);
      ctx.lineTo(bar.x, bar.y + r);
      ctx.quadraticCurveTo(bar.x, bar.y, bar.x + r, bar.y);
      ctx.lineTo(bar.x + bar.w - r, bar.y);
      ctx.quadraticCurveTo(bar.x + bar.w, bar.y, bar.x + bar.w, bar.y + r);
      ctx.lineTo(bar.x + bar.w, pad.top + chartH);
      ctx.closePath();
      ctx.fill();

      // X-axis label
      const showLabel = rows.length <= 10 || i % 2 === 0;
      if (showLabel) {
        ctx.fillStyle = isHL ? "#e2e8f0" : "#64748b";
        ctx.font = `${isHL ? "bold " : ""}10px 'Fira Code', ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = bar.date ? bar.date.slice(5) : "";
        ctx.fillText(label, bar.x + bar.w / 2, pad.top + chartH + 8);
      }
    });

    // Line: API request count
    const linePoints = bars.map((bar) => ({
      x: bar.x + bar.w / 2,
      y: pad.top + chartH - Math.max(2, (chartH * (bar.requests || 0)) / requestMax),
    }));

    // Area fill
    if (linePoints.length > 1) {
      ctx.beginPath();
      ctx.moveTo(linePoints[0].x, pad.top + chartH);
      for (const pt of linePoints) ctx.lineTo(pt.x, pt.y);
      ctx.lineTo(linePoints[linePoints.length - 1].x, pad.top + chartH);
      ctx.closePath();
      ctx.fillStyle = REQUEST_COLOR_GLOW;
      ctx.fill();
    }

    // Line
    ctx.strokeStyle = REQUEST_COLOR;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(linePoints[0].x, linePoints[0].y);
    for (let i = 1; i < linePoints.length; i++) {
      const prev = linePoints[i - 1];
      const cpX = (prev.x + linePoints[i].x) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, cpX, (prev.y + linePoints[i].y) / 2);
      ctx.lineTo(linePoints[i].x, linePoints[i].y);
    }
    ctx.stroke();

    // Data-point dots
    linePoints.forEach((pt, i) => {
      const isHL = highlightIndex === i;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isHL ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isHL ? REQUEST_COLOR_HL : "#0b1120";
      ctx.fill();
      ctx.strokeStyle = isHL ? REQUEST_COLOR_HL : REQUEST_COLOR;
      ctx.lineWidth = isHL ? 2.5 : 2;
      ctx.stroke();
    });

    // Legend
    const legendY = 12;
    ctx.font = "10px 'Fira Code', ui-monospace, monospace";
    ctx.fillStyle = TOKEN_COLOR;
    ctx.fillRect(pad.left, legendY - 3, 10, 10);
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "start";
    ctx.textBaseline = "middle";
    ctx.fillText("Tokens", pad.left + 14, legendY + 2);

    const reqLegendX = pad.left + 80;
    ctx.strokeStyle = REQUEST_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(reqLegendX, legendY + 2);
    ctx.lineTo(reqLegendX + 14, legendY + 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(reqLegendX + 7, legendY + 2, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#0b1120";
    ctx.fill();
    ctx.strokeStyle = REQUEST_COLOR;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#94a3b8";
    ctx.fillText("Requests", reqLegendX + 18, legendY + 2);
  }

  // Animation: interpolate bar heights from previous values
  const newHeights = bars.map((b) => b.h);
  if (trendPrevBars && trendPrevBars.length === newHeights.length) {
    cancelAnimationFrame(trendAnimId);
    trendAnimStart = performance.now();
    const startHeights = [...trendPrevBars];
    const targetHeights = [...newHeights];

    function animate(now) {
      const elapsed = now - trendAnimStart;
      const t = Math.min(1, elapsed / TREND_ANIM_DURATION);
      const e = easeOutCubic(t);
      for (let i = 0; i < bars.length; i++) {
        const h = startHeights[i] + (targetHeights[i] - startHeights[i]) * e;
        bars[i].h = h;
        bars[i].y = pad.top + chartH - h;
      }
      draw(-1);
      if (t < 1) {
        trendAnimId = requestAnimationFrame(animate);
      } else {
        trendPrevBars = targetHeights;
        trendAnimId = null;
      }
    }
    trendAnimId = requestAnimationFrame(animate);
  } else {
    draw(-1);
    trendPrevBars = newHeights;
  }

  // ── Hover interaction ──
  canvas.onmousemove = function (e) {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;

    // Find closest bar by X position
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < bars.length; i++) {
      const cx = bars[i].x + bars[i].w / 2;
      const dist = Math.abs(mx - cx);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }

    const inChart = mx >= pad.left && mx <= W - pad.right && my >= 0 && my <= H;
    if (!inChart || bestIdx < 0) {
      tooltip.hidden = true;
      draw(-1);
      return;
    }

    const bar = bars[bestIdx];
    draw(bestIdx);

    // Position tooltip above the bar
    const tx = bar.x + bar.w / 2;
    const ty = bar.y - 10;
    tooltip.hidden = false;
    tooltip.innerHTML =
      `<div class="chart-tooltip-date">${bar.date}</div>` +
      `<div class="chart-tooltip-row"><span class="chart-tooltip-dot tokens"></span> Tokens: ${fmtNumber(bar.tokens)}</div>` +
      `<div class="chart-tooltip-row"><span class="chart-tooltip-dot requests"></span> Requests: ${fmtNumber(bar.requests)}</div>`;
    tooltip.style.left = tx + "px";
    tooltip.style.top = ty + "px";
  };

  canvas.onmouseleave = function () {
    tooltip.hidden = true;
    draw(-1);
  };
}

/* ── Render: Active Session & Limits ─────── */

function limitRow(label, pct, windowMin, resetsAt, generatedAt, planType, limitUpdatedAt) {
  // Detect stale/reset: if resets_at is already in the past, limit has been reset
  const now = new Date();
  const resetDate = resetsAt ? new Date(resetsAt) : null;
  const hasReset = resetDate && resetDate < now;

  // If reset already happened, show 0% instead of stale data
  const displayPct = hasReset ? 0 : pct;
  const ratio = Math.max(0, Math.min(1, displayPct / 100));
  const badge = hasReset ? "ok" : limitBadge(displayPct);
  const barClass = displayPct >= 90 ? "danger" : displayPct >= 70 ? "warn" : "";

  // Time progress
  let timePct = null;
  let paceNote = "";
  if (resetsAt && windowMin && !hasReset) {
    const windowStart = new Date(resetDate.getTime() - windowMin * 60000);
    const elapsed = (now - windowStart) / 60000;
    timePct = Math.max(0, Math.min(100, (elapsed / windowMin) * 100));
    if (timePct < 99) {
      paceNote = displayPct > timePct + 5
        ? ` · <span style="color:#f59e0b">⚠ ${(displayPct - timePct).toFixed(0)}% ahead of time</span>`
        : ` · <span style="color:#22c55e">on pace</span>`;
    }
  }

  const timeMarker = timePct != null && timePct < 99
    ? `<div class="bar-time-marker" style="left:${timePct}%" title="Time elapsed: ${timePct.toFixed(0)}%"></div>`
    : "";

  // Build detail line
  let detail = `${windowMin ? windowMin + 'm window' : ''}`;
  if (hasReset) {
    detail += ` · <span style="color:#22c55e">reset ${fmtCompactTime(resetsAt)}</span>`;
  } else if (resetsAt) {
    detail += ` · resets ${fmtCompactTime(resetsAt)}`;
  }
  if (planType) detail += ` · ${planType}`;
  if (limitUpdatedAt && hasReset) {
    detail += ` · <span style="color:#64748b">data from ${fmtCompactTime(limitUpdatedAt)}</span>`;
  }
  detail += paceNote;

  return `<div class="row">
    <div>
      <div class="row-title">${esc(label)}${badge ? ` <span class="badge badge-${esc(badge)}">${esc(badge)}</span>` : ""}</div>
      <div class="row-detail">${detail}</div>
      <div class="bar-track">
        <div class="bar-fill${barClass ? " " + barClass : ""}" style="width:${ratio * 100}%"></div>
        ${timeMarker}
        ${timePct != null && timePct < 99 ? `<div style="font-size:9px;color:var(--ink-muted);margin-top:2px">usage ${displayPct.toFixed(0)}% · time ${timePct.toFixed(0)}%</div>` : ""}
      </div>
    </div>
    <div class="row-value">${hasReset ? '0%' : fmtPercent(displayPct)}</div>
  </div>`;
}

function renderActive(snapshot) {
  const active = snapshot.active_session;
  const limits = snapshot.limits || {};
  const generatedAt = snapshot.generated_at || null;
  const limitUpdatedAt = snapshot.limit_updated_at || null;
  const rows = [];

  if (active) {
    const badge = sessionBadge(active);
    rows.push(usageRow(
      active.displayName || active.sessionFile || "Unknown",
      `${active.projectName || "unknown"} · ${envLabel(active)} · last ${fmtCompactTime(active.lastActivity)}`,
      fmtShort(active.totalTokens),
      { badge },
    ));
  } else {
    rows.push(`<div class="empty"><p>No session data available</p></div>`);
  }

  if (limits.primary) {
    rows.push(limitRow(
      "Primary Rate Limit",
      Number(limits.primary.used_percent || 0),
      limits.primary.window_minutes,
      limits.primary.resets_at,
      generatedAt,
      null,
      limitUpdatedAt,
    ));
  }

  if (limits.secondary) {
    rows.push(limitRow(
      "Secondary Rate Limit",
      Number(limits.secondary.used_percent || 0),
      limits.secondary.window_minutes,
      limits.secondary.resets_at,
      generatedAt,
      null,
      limitUpdatedAt,
    ));
  }

  // Billing note
  rows.push(`<div class="billing-note">
    <span>Codex</span> (subscription) — rate-limited per window above ·
    <span>DeepSeek</span> (pay-per-use) — no rate limits, billed per token
  </div>`);

  $("active").innerHTML = rows.join("");
}

/* ── Fast limits refresh ─────────────────── */

async function refreshLimitsOnly() {
  const btn = $("refreshLimits");
  btn.disabled = true;
  btn.textContent = "↻ …";
  try {
    const res = await fetch("/api/limits", { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    // Merge refreshed limits into the cached snapshot
    if (latestSnapshot) {
      latestSnapshot.limits = data.limits;
      latestSnapshot.limit_updated_at = data.limit_updated_at;
    }
    renderActive(latestSnapshot || { limits: data.limits, limit_updated_at: data.limit_updated_at });
    const srcLabel = data.source === "synced_device" ? " (from synced device)" : "";
    if (data.stale) {
      toast(`Limits data is ${data.limit_age_hours}h old${srcLabel} — use Codex once to refresh`, "error");
    } else {
      toast(`Limits refreshed${srcLabel}`, "success");
    }
  } catch (err) {
    toast("Limits refresh failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "↻ Limits";
  }
}

$("refreshLimits").addEventListener("click", () => {
  refreshLimitsOnly().catch(() => {});
});

/* ── Render: Projects ────────────────────── */

function renderProjects(snapshot) {
  const projects = snapshot.top_projects || [];
  if (!projects.length) {
    $("projects").innerHTML = emptyState("No project data");
    return;
  }
  const total = projects.reduce((s, p) => s + (p.totalTokens || 0), 0) || 1;
  $("projects").innerHTML = projects.map((p) =>
    usageRow(
      p.projectName || "unknown",
      `${envLabel(p)} · ${p.projectPath || ""}`,
      fmtShort(p.totalTokens),
      { ratio: (p.totalTokens || 0) / total },
    )
  ).join("");
}

/* ── Render: Model Breakdown ─────────────── */

function drawModelChart(snapshot) {
  const canvas = $("modelsChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const tooltip = $("modelsChartTooltip");
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  // Cache snapshot for resize re-render
  window.__modelChartSnapshot = snapshot;

  // Set aria-label
  {
    const allEntries = Object.entries(snapshot.models || {});
    if (allEntries.length) {
      const sorted = [...allEntries].sort((a, b) => b[1].totalTokens - a[1].totalTokens);
      const topModel = sorted[0][0];
      const topTokens = fmtShort(sorted[0][1].totalTokens || 0);
      canvas.setAttribute("aria-label", `Model usage: ${topModel} leads with ${topTokens} tokens, ${allEntries.length} models total`);
    }
  }

  // Gather and sort model data (by token count descending)
  let entries = Object.entries(snapshot.models || {})
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens);

  if (!entries.length) return;

  // Max 8 models shown; merge rest into "others"
  let othersTokens = 0, othersEvents = 0;
  if (entries.length > 8) {
    const tail = entries.splice(8);
    for (const [, u] of tail) {
      othersTokens += u.totalTokens || 0;
      othersEvents += u.eventCount || 0;
    }
  }
  // Only add "others" row if there is actually merged data
  if (othersTokens > 0 || othersEvents > 0) {
    entries.push(["others", { totalTokens: othersTokens, eventCount: othersEvents }]);
  }

  const count = entries.length;
  if (!count) return;

  // Layout — generous padding so Y-axis labels don't clip and legend clears tallest bars
  const pad = { top: 42, right: 52, bottom: 56, left: 56 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;

  const CACHE_COLOR = "#16a34a";   // dark green — cache hit
  const CACHE_COLOR_HL = "#22c55e";
  const INPUT_COLOR = "#4ade80";   // light green — new input
  const INPUT_COLOR_HL = "#86efac";
  const OUTPUT_COLOR = "#3b82f6";  // blue — output
  const OUTPUT_COLOR_HL = "#60a5fa";

  // Sort by token descending
  entries.sort((a, b) =>
    ((b[1].cacheReadTokens || 0) + (b[1].inputTokens || 0) + (b[1].outputTokens || 0)) -
    ((a[1].cacheReadTokens || 0) + (a[1].inputTokens || 0) + (a[1].outputTokens || 0))
  );

  // Find max total for Y-axis scale
  const tokenMax = Math.max(...entries.map(([, u]) =>
    (u.cacheReadTokens || 0) + (u.inputTokens || 0) + (u.outputTokens || 0)
  ), 1);
  const requestMax = Math.max(...entries.map(([, u]) => u.eventCount || 0), 1);

  // Single bar per model, stacked
  const barW = Math.max(14, Math.min(50, (chartW / count) * 0.55));
  const groupStep = chartW / count;

  const bars = entries.map(([model, usage], i) => {
    const cacheH = Math.max(0, (chartH * (usage.cacheReadTokens || 0)) / tokenMax);
    const inputH = Math.max(0, (chartH * (usage.inputTokens || 0)) / tokenMax);
    const outputH = Math.max(0, (chartH * (usage.outputTokens || 0)) / tokenMax);
    const totalH = cacheH + inputH + outputH;
    const x = pad.left + i * groupStep + (groupStep - barW) / 2;
    const baseY = pad.top + chartH;
    return {
      x, barW,
      cache:  { y: baseY - totalH, h: cacheH },
      input:  { y: baseY - totalH + cacheH, h: inputH },
      output: { y: baseY - totalH + cacheH + inputH, h: outputH },
      model, groupX: x, groupW: barW,
      cacheTokens: usage.cacheReadTokens || 0,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      totalTokens: (usage.cacheReadTokens || 0) + (usage.inputTokens || 0) + (usage.outputTokens || 0),
      requests: usage.eventCount || 0,
    };
  });

  function draw(highlightIdx) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0b1120";
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    const gridLines = 3;
    for (let i = 0; i <= gridLines; i++) {
      const y = pad.top + (chartH * i) / gridLines;
      ctx.strokeStyle = "#1e293b";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, Math.round(y) + 0.5);
      ctx.lineTo(W - pad.right, Math.round(y) + 0.5);
      ctx.stroke();

      // Left Y-axis: tokens
      const tokenVal = tokenMax - (tokenMax * i) / gridLines;
      ctx.fillStyle = TOKEN_COLOR;
      ctx.font = "10px 'Fira Code', ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(fmtShort(tokenVal), pad.left - 8, Math.round(y));

      // Right Y-axis: requests
      const reqVal = requestMax - (requestMax * i) / gridLines;
      ctx.fillStyle = REQUEST_COLOR;
      ctx.textAlign = "left";
      ctx.fillText(fmtShort(reqVal), W - pad.right + 8, Math.round(y));
    }

    // Stacked bars (drawn first, below the request line)
    bars.forEach((bar, i) => {
      const isHL = highlightIdx === i;
      const x = bar.x, w = bar.barW;

      // Cache hit segment (bottom, dark green)
      if (bar.cache.h > 0.5) {
        ctx.fillStyle = isHL ? CACHE_COLOR_HL : CACHE_COLOR;
        ctx.fillRect(x, bar.cache.y, w, Math.max(1, bar.cache.h));
      }
      // New input segment (middle, light green)
      if (bar.input.h > 0.5) {
        ctx.fillStyle = isHL ? INPUT_COLOR_HL : INPUT_COLOR;
        ctx.fillRect(x, bar.input.y, w, Math.max(1, bar.input.h));
      }
      // Output segment (top, blue)
      if (bar.output.h > 0.5) {
        ctx.fillStyle = isHL ? OUTPUT_COLOR_HL : OUTPUT_COLOR;
        ctx.fillRect(x, bar.output.y, w, Math.max(1, bar.output.h));
      }

      // Total value label on top
      if (bar.cache.h + bar.input.h + bar.output.h > 16) {
        ctx.font = "9px 'Fira Code', ui-monospace, monospace";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "#e2e8f0";
        ctx.textAlign = "center";
        ctx.fillText(fmtShort(bar.totalTokens), x + w / 2, bar.cache.y - 2);
      }
    });

    // Request count line (overlay, drawn AFTER bars)
    const reqPoints = bars.map((bar) => ({
      x: bar.groupX + bar.groupW / 2,
      y: pad.top + chartH - Math.max(2, (chartH * (bar.requests || 0)) / requestMax),
    }));
    if (reqPoints.length > 1) {
      ctx.beginPath();
      ctx.moveTo(reqPoints[0].x, pad.top + chartH);
      for (const pt of reqPoints) ctx.lineTo(pt.x, pt.y);
      ctx.lineTo(reqPoints[reqPoints.length - 1].x, pad.top + chartH);
      ctx.closePath();
      ctx.fillStyle = REQUEST_COLOR_GLOW;
      ctx.fill();
    }
    ctx.strokeStyle = REQUEST_COLOR;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < reqPoints.length; i++) {
      const pt = reqPoints[i];
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else {
        const prev = reqPoints[i - 1];
        ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + pt.x) / 2, (prev.y + pt.y) / 2);
        ctx.lineTo(pt.x, pt.y);
      }
    }
    ctx.stroke();
    reqPoints.forEach((pt, i) => {
      const isHL = highlightIdx === i;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isHL ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isHL ? REQUEST_COLOR_HL : "#0b1120";
      ctx.fill();
      ctx.strokeStyle = isHL ? REQUEST_COLOR_HL : REQUEST_COLOR;
      ctx.lineWidth = isHL ? 2 : 1.5;
      ctx.stroke();
    });

    // X-axis labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    bars.forEach((bar, i) => {
      const isHL = highlightIdx === i;
      let label = bar.model;
      if (label.length > 14) label = label.slice(0, 12) + "…";
      ctx.fillStyle = isHL ? "#e2e8f0" : "#64748b";
      ctx.font = `${isHL ? "bold " : ""}10px 'Fira Code', ui-monospace, monospace`;
      ctx.fillText(label, bar.groupX + bar.groupW / 2, pad.top + chartH + 8);

      // Cache % below name
      const cachePct = bar.totalTokens > 0 ? Math.round(bar.cacheTokens / bar.totalTokens * 100) : 0;
      ctx.fillStyle = isHL ? "#94a3b8" : "#475569";
      ctx.font = "8px 'Fira Code', ui-monospace, monospace";
      ctx.fillText(`${cachePct}% cache`, bar.groupX + bar.groupW / 2, pad.top + chartH + 22);
    });

    // Legend
    const legendY = 6;
    ctx.font = "10px 'Fira Code', ui-monospace, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "start";

    let lx = pad.left;
    ctx.fillStyle = CACHE_COLOR; ctx.fillRect(lx, legendY, 10, 10);
    ctx.fillStyle = "#94a3b8"; ctx.fillText("Cache", lx + 14, legendY + 5);

    lx += 60;
    ctx.fillStyle = INPUT_COLOR; ctx.fillRect(lx, legendY, 10, 10);
    ctx.fillStyle = "#94a3b8"; ctx.fillText("Input", lx + 14, legendY + 5);

    lx += 60;
    ctx.fillStyle = OUTPUT_COLOR; ctx.fillRect(lx, legendY, 10, 10);
    ctx.fillStyle = "#94a3b8"; ctx.fillText("Output", lx + 14, legendY + 5);

    lx += 70;
    ctx.strokeStyle = REQUEST_COLOR; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lx, legendY + 5); ctx.lineTo(lx + 12, legendY + 5); ctx.stroke();
    ctx.beginPath(); ctx.arc(lx + 6, legendY + 5, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#0b1120"; ctx.fill();
    ctx.strokeStyle = REQUEST_COLOR; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = "#94a3b8"; ctx.textAlign = "start";
    ctx.fillText("Requests", lx + 16, legendY + 5);
  }

  draw(-1);

  // ── Hover interaction ──
  canvas.onmousemove = function (e) {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;

    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < bars.length; i++) {
      const cx = bars[i].groupX + bars[i].groupW / 2;
      const dist = Math.abs(mx - cx);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }

    if (bestIdx < 0 || bestDist > groupStep / 2 + 4) {
      tooltip.hidden = true;
      draw(-1);
      return;
    }

    const bar = bars[bestIdx];
    draw(bestIdx);

    const tx = bar.groupX + bar.groupW / 2;
    const ty = bar.cache.y - 10;
    const cachePct = bar.totalTokens > 0 ? Math.round(bar.cacheTokens / bar.totalTokens * 100) : 0;

    const modelLabel = bar.model === "others" ? "Others" : bar.model;
    tooltip.hidden = false;
    tooltip.innerHTML =
      `<div class="chart-tooltip-date">${esc(modelLabel)}</div>` +
      `<div class="chart-tooltip-row"><span class="chart-tooltip-dot" style="background:#16a34a"></span> Cache: ${fmtNumber(bar.cacheTokens)} (${cachePct}%)</div>` +
      `<div class="chart-tooltip-row"><span class="chart-tooltip-dot" style="background:#4ade80"></span> Input: ${fmtNumber(bar.inputTokens)}</div>` +
      `<div class="chart-tooltip-row"><span class="chart-tooltip-dot" style="background:#3b82f6"></span> Output: ${fmtNumber(bar.outputTokens)}</div>` +
      `<div class="chart-tooltip-row"><span style="color:#64748b">Requests: ${fmtNumber(bar.requests)}</span></div>`;
    tooltip.style.left = tx + "px";
    tooltip.style.top = ty + "px";
  };

  canvas.onmouseleave = function () {
    tooltip.hidden = true;
    draw(-1);
  };
}

function renderModels(snapshot) {
  // Canvas chart (JS active — hide fallback list)
  drawModelChart(snapshot);
  $("models").style.display = "none";

  // Fallback list for no-js (hidden when canvas is active)
  const entries = Object.entries(snapshot.models || {})
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  if (!entries.length) {
    $("models").innerHTML = emptyState("No model data");
    return;
  }
  const total = entries.reduce((s, [, u]) => s + (u.totalTokens || 0), 0) || 1;
  $("models").innerHTML = entries.map(([model, usage]) =>
    usageRow(
      model,
      usage.isFallback ? "inferred" : "",
      fmtShort(usage.totalTokens),
      { ratio: (usage.totalTokens || 0) / total },
    )
  ).join("");
}

/* ── Render: Skills ──────────────────────── */

function renderSkills(snapshot) {
  const skills = snapshot.skills || [];
  if (!skills.length) {
    $("skills").innerHTML = emptyState("No tool/skill data");
    return;
  }
  $("skills").innerHTML = skills.map((s) => {
    const hasTokens = s.totalTokens && s.totalTokens > 0;
    const detail = `${s.count} call${s.count !== 1 ? "s" : ""}${hasTokens ? "" : " · Codex MCP tool"}`;
    return usageRow(
      s.name,
      detail,
      hasTokens ? fmtShort(s.totalTokens) : "—",
    );
  }).join("");
}

/* ── Render: Top Sessions ────────────────── */

function renderSessions(snapshot) {
  const sessions = snapshot.top_sessions || [];
  if (!sessions.length) {
    $("sessions").innerHTML = emptyState("No session data");
    return;
  }
  $("sessions").innerHTML = sessions.map((s) =>
    usageRow(
      s.displayName || s.sessionFile || s.sessionId,
      `${s.projectName || "unknown"} · ${envLabel(s)} · ${fmtCompactTime(s.lastActivity)}`,
      fmtShort(s.totalTokens),
    )
  ).join("");
}

/* ── Render: Heatmap (Monthly Calendar) ──── */

const HEAT_COLORS = [
  "#1e293b",  // no data
  "#0e4429",  // Q1
  "#006d32",  // Q2
  "#26a641",  // Q3
  "#39d353",  // Q4
];

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];
const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Current heatmap month (updated by nav buttons)
let hmMonth = new Date().getMonth();     // 0-11
let hmYear = new Date().getFullYear();

function drawHeatmap(snapshot) {
  const canvas = $("heatmap");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const tooltip = $("heatmapTooltip");
  const rows = snapshot.activity_days || snapshot.recent_days || [];
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.getBoundingClientRect();
  const W = rect.width;

  // Build date -> tokens map
  const dateMap = new Map();
  for (const r of rows) {
    if (r.date) dateMap.set(r.date, r.totalTokens || 0);
  }

  // Compute quantile thresholds from ALL data
  const nonZero = rows.map((r) => r.totalTokens || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const q1 = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length * 0.25)] : 0;
  const q2 = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length * 0.50)] : 0;
  const q3 = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length * 0.75)] : 0;

  function getLevel(tokens) {
    if (!tokens || tokens <= 0) return 0;
    if (tokens <= q1) return 1;
    if (tokens <= q2) return 2;
    if (tokens <= q3) return 3;
    return 4;
  }

  function monthMeta(year, month) {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    let startDow = firstDay.getDay();
    startDow = startDow === 0 ? 6 : startDow - 1;
    const daysInMonth = lastDay.getDate();
    return {
      year,
      month,
      startDow,
      daysInMonth,
      cols: Math.ceil((startDow + daysInMonth) / 7),
    };
  }

  const months = [];
  for (let offset = 2; offset >= 0; offset -= 1) {
    const date = new Date(hmYear, hmMonth - offset, 1);
    months.push(monthMeta(date.getFullYear(), date.getMonth()));
  }

  const numRows = 7;

  // Layout
  const labelW = 18;
  const topH = 20;
  const legendH = 22;
  const cellGap = 3;
  const maxCellSize = 18;
  const rightPad = 8;
  const monthGap = 14;
  const totalCols = months.reduce((sum, month) => sum + month.cols, 0);

  const availableW = W - labelW - rightPad - 4 - monthGap * (months.length - 1);
  const rawStep = Math.floor(availableW / Math.max(1, totalCols));
  const cellStep = Math.max(7, Math.min(rawStep, maxCellSize + cellGap));
  const cellSize = Math.max(4, cellStep - cellGap);

  // Center the grid horizontally
  const gridW = totalCols * cellStep + monthGap * (months.length - 1);
  const gridH = numRows * cellStep;
  const gridLeft = labelW + 4 + Math.max(0, Math.floor((W - labelW - rightPad - 4 - gridW) / 2));
  const gridTop = topH;

  // Canvas dimensions
  const neededH = gridTop + gridH + legendH + 6;
  canvas.height = neededH * dpr;
  canvas.width = W * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  const H = neededH;
  ctx.clearRect(0, 0, W, H);

  // ── Day-of-week labels (left, one per row) ──
  ctx.font = "9px 'Fira Code', ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#64748b";
  for (let row = 0; row < numRows; row++) {
    const y = gridTop + row * cellStep + cellSize / 2;
    ctx.fillText(DAY_LABELS[row], labelW, y);
  }

  // ── Draw cells ──
  const cells = [];
  let monthLeft = gridLeft;
  for (const month of months) {
    const monthW = month.cols * cellStep;
    ctx.font = "10px 'Fira Code', ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(`${MONTHS_FULL[month.month].slice(0, 3)} ${month.year}`, monthLeft + monthW / 2, 2);

    for (let col = 0; col < month.cols; col++) {
      for (let row = 0; row < numRows; row++) {
        const dayNum = col * 7 + row - month.startDow + 1;
        if (dayNum < 1 || dayNum > month.daysInMonth) continue;

        const x = monthLeft + col * cellStep;
        const y = gridTop + row * cellStep;

        const mm = String(month.month + 1).padStart(2, "0");
        const dd = String(dayNum).padStart(2, "0");
        const dateStr = `${month.year}-${mm}-${dd}`;

        const tokens = dateMap.get(dateStr) || 0;
        const level = getLevel(tokens);

        const r = Math.min(3, cellSize / 3);
        ctx.fillStyle = HEAT_COLORS[level];
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + cellSize - r, y);
        ctx.quadraticCurveTo(x + cellSize, y, x + cellSize, y + r);
        ctx.lineTo(x + cellSize, y + cellSize - r);
        ctx.quadraticCurveTo(x + cellSize, y + cellSize, x + cellSize - r, y + cellSize);
        ctx.lineTo(x + r, y + cellSize);
        ctx.quadraticCurveTo(x, y + cellSize, x, y + cellSize - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fill();

        cells.push({ x, y, w: cellSize, h: cellSize, date: dateStr, tokens });
      }
    }
    monthLeft += monthW + monthGap;
  }

  // ── Color legend ("Less … More") ──
  const legendY = gridTop + gridH + 8;
  const lgSize = 10;
  const lgGap = 2;
  const lgStartX = gridLeft;

  ctx.font = "9px 'Fira Code', ui-monospace, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "start";
  ctx.fillStyle = "#64748b";
  ctx.fillText("Less", lgStartX, legendY);

  for (let i = 0; i < 5; i++) {
    const lx = lgStartX + 30 + i * (lgSize + lgGap);
    ctx.fillStyle = HEAT_COLORS[i];
    ctx.fillRect(lx, legendY + 1, lgSize, lgSize);
  }

  ctx.fillStyle = "#64748b";
  ctx.fillText("More", lgStartX + 30 + 5 * (lgSize + lgGap) + 4, legendY);

  // ── Hover interaction ──
  canvas.onmousemove = function (e) {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    let found = null;
    for (const c of cells) {
      if (mx >= c.x - 2 && mx <= c.x + c.w + 2 && my >= c.y - 2 && my <= c.y + c.h + 2) {
        found = c; break;
      }
    }
    if (!found) { tooltip.hidden = true; return; }
    const tx = found.x + found.w / 2;
    const ty = found.y - 6;
    tooltip.hidden = false;
    tooltip.innerHTML =
      `<div class="chart-tooltip-date">${found.date}</div>` +
      `<div class="chart-tooltip-row">Tokens: ${fmtNumber(found.tokens)}</div>`;
    tooltip.style.left = tx + "px";
    tooltip.style.top = ty + "px";
  };
  canvas.onmouseleave = function () { tooltip.hidden = true; };

  // Update month label
  const first = months[0];
  const last = months[months.length - 1];
  $("heatmapMonth").textContent = `${MONTHS_FULL[first.month].slice(0, 3)} ${first.year} - ${MONTHS_FULL[last.month].slice(0, 3)} ${last.year}`;
}

/* ── Main Refresh ────────────────────────── */

let latestSnapshot = null;
let trendViewIndex = 0;
let sourcePromptShown = false;

function trendViews(snapshot) {
  const views = snapshot?.trend_views;
  if (Array.isArray(views) && views.length > 0) return views;
  return [{
    id: "total",
    label: "total",
    display_name: "total",
    recent_days: snapshot?.recent_days || [],
    today: snapshot?.today || null,
    totals: snapshot?.totals || null,
  }];
}

function selectedTrendSnapshot(snapshot) {
  const views = trendViews(snapshot);
  if (trendViewIndex >= views.length) trendViewIndex = 0;
  const view = views[trendViewIndex] || views[0];
  return {
    ...snapshot,
    recent_days: view.recent_days || [],
    today: view.today || null,
    totals: view.totals || null,
  };
}

function renderTrend(snapshot) {
  const views = trendViews(snapshot);
  if (trendViewIndex >= views.length) trendViewIndex = 0;
  const view = views[trendViewIndex] || views[0];
  $("trendViewLabel").textContent = view.display_name || view.label || "total";
  drawTrend(selectedTrendSnapshot(snapshot));
}

async function refresh() {
  $("meta").textContent = "Refreshing…";
  const response = await fetch("/api/snapshot", { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  const snapshot = await response.json();
  latestSnapshot = snapshot;

  renderMetrics(snapshot);
  drawHeatmap(snapshot);
  renderTrend(snapshot);
  renderActive(snapshot);
  renderProjects(snapshot);
  renderModels(snapshot);
  renderSkills(snapshot);
  renderSessions(snapshot);
  maybePromptSourceImport(snapshot);
}

async function maybePromptSourceImport(snapshot) {
  if (sourcePromptShown) return;
  const eventCount = snapshot.totals?.eventCount || snapshot.diagnostics?.events_read || 0;
  if (eventCount > 0) return;
  sourcePromptShown = true;
  const panel = $("sourcesPanel");
  panel.style.display = "";
  await loadSources("Confirm detected sources to import");
}

/* ── Sync Panel ──────────────────────────── */

let syncServerUrl = "";
let syncToken = "";

function loadSyncState() {
  syncServerUrl = localStorage.getItem("syncServer") || "";
  syncToken = localStorage.getItem("syncToken") || "";
  $("syncServer").value = syncServerUrl;
  $("syncToken").value = syncToken;
  updateSyncTimes();
}

async function updateSyncTimes() {
  try {
    const res = await fetch("/api/sync-state");
    if (!res.ok) return;
    const state = await res.json();
    $("syncLastPush").textContent = state.lastPushAt
      ? `Last push: ${fmtCompactTime(state.lastPushAt)}`
      : "Never pushed";
    $("syncLastPull").textContent = state.lastPullAt
      ? `Last pull: ${fmtCompactTime(state.lastPullAt)}`
      : "Never pulled";
    if (state.server && !syncServerUrl) {
      syncServerUrl = state.server;
      $("syncServer").value = state.server;
    }
  } catch {}
}

$("syncSave").addEventListener("click", async () => {
  const url = $("syncServer").value.trim();
  const token = $("syncToken").value.trim();
  if (!url) { $("syncConnStatus").textContent = "Enter a server URL"; return; }

  $("syncConnStatus").textContent = "Connecting…";
  try {
    // Proxy through local server to avoid CORS issues
    const res = await fetch("/api/proxy-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: url }),
    });
    if (!res.ok) throw new Error(await res.text());
    syncServerUrl = url;
    syncToken = token;
    localStorage.setItem("syncServer", url);
    localStorage.setItem("syncToken", token);
    $("syncConnStatus").innerHTML = `<span style="color:#22c55e">● connected</span>`;
    updateSyncTimes();
  } catch (err) {
    $("syncConnStatus").innerHTML = `<span style="color:#ef4444">● ${esc(err.message)}</span>`;
  }
});

$("syncPush").addEventListener("click", async () => {
  if (!syncServerUrl) { toast("Save server first", "error"); return; }
  $("syncStatus").textContent = "Pushing…";
  try {
    const res = await fetch("/api/push-to-remote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: syncServerUrl, token: syncToken }),
    });
    if (!res.ok) throw new Error(await res.text());
    $("syncStatus").textContent = "Push OK ✓";
    updateSyncTimes();
    toast("Push successful ✓", "success");
  } catch (err) {
    $("syncStatus").textContent = "Push failed: " + err.message;
    toast("Push failed: " + err.message, "error");
  }
});

$("syncPull").addEventListener("click", async () => {
  if (!syncServerUrl) { toast("Save server first", "error"); return; }
  $("syncStatus").textContent = "Pulling…";
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: syncServerUrl }),
    });
    if (!res.ok) throw new Error(await res.text());
    const result = await res.json();
    $("syncStatus").textContent = result.message;
    updateSyncTimes();
    await refresh();
    toast(result.message, "success");
  } catch (err) {
    $("syncStatus").textContent = "Pull failed: " + err.message;
    toast("Pull failed: " + err.message, "error");
  }
});

/* ── Bootstrap ───────────────────────────── */

$("refresh").addEventListener("click", () => {
  refresh().catch((err) => {
    $("meta").textContent = err.message;
  });
});

$("syncBtn").addEventListener("click", () => {
  const panel = $("syncPanel");
  if (panel.style.display === "none") {
    panel.style.display = "";
    loadSyncState();
  } else {
    panel.style.display = "none";
  }
});

$("trendPrev").addEventListener("click", () => {
  if (!latestSnapshot) return;
  const canvas = $("trend");
  canvas.style.opacity = "0";
  setTimeout(() => {
    const views = trendViews(latestSnapshot);
    trendViewIndex = (trendViewIndex - 1 + views.length) % views.length;
    renderTrend(latestSnapshot);
    canvas.style.opacity = "1";
  }, 120);
});

$("trendNext").addEventListener("click", () => {
  if (!latestSnapshot) return;
  const canvas = $("trend");
  canvas.style.opacity = "0";
  setTimeout(() => {
    const views = trendViews(latestSnapshot);
    trendViewIndex = (trendViewIndex + 1) % views.length;
    renderTrend(latestSnapshot);
    canvas.style.opacity = "1";
  }, 120);
});

/* Heatmap month navigation */
$("hmPrev").addEventListener("click", () => {
  if (hmMonth === 0) { hmMonth = 11; hmYear--; }
  else hmMonth--;
  fetch("/api/snapshot", { cache: "no-store" })
    .then((r) => r.json())
    .then((snap) => drawHeatmap(snap))
    .catch(() => {});
});

$("hmNext").addEventListener("click", () => {
  if (hmMonth === 11) { hmMonth = 0; hmYear++; }
  else hmMonth++;
  fetch("/api/snapshot", { cache: "no-store" })
    .then((r) => r.json())
    .then((snap) => drawHeatmap(snap))
    .catch(() => {});
});

/* Handle resize for canvas DPI */
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fetch("/api/snapshot", { cache: "no-store" })
      .then((r) => r.json())
      .then((snap) => {
        latestSnapshot = snap;
        drawHeatmap(snap);
        renderTrend(snap);
        drawModelChart(snap);
      })
      .catch(() => {
        // Fallback: re-draw with cached snapshot if fetch fails
        if (window.__modelChartSnapshot) drawModelChart(window.__modelChartSnapshot);
      });
  }, 200);
});

refresh().catch((err) => {
  $("meta").textContent = err.message;
});

/* ── Sources Panel ───────────────────────── */

$("sourcesBtn").addEventListener("click", async () => {
  const panel = $("sourcesPanel");
  if (panel.style.display === "none") {
    panel.style.display = "";
    await loadSources();
  } else {
    panel.style.display = "none";
  }
});

async function loadSources(message = "") {
  try {
    const res = await fetch("/api/sources");
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const items = [];
    function sourceBadge(status) {
      if (status === "ok") return "ok";
      if (status === "empty") return "idle";
      if (status === "missing" || status === "unreadable") return "hit";
      return "near";
    }
    function sourceRow(d, action = "") {
      const status = d.status || "unknown";
      const detail = [
        `[${d.type}]`,
        d.display_name || d.detected_name || d.label || "",
        `${d.files_found || 0} files`,
        d.message || "",
        d.addedAt || "",
      ].filter(Boolean).join(" · ");
      return `<div class="row">
        <div><div class="row-title">${esc(d.normalized_path || d.path)}</div><div class="row-detail">${esc(detail)}</div></div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="badge badge-${sourceBadge(status)}" style="font-size:10px">${esc(status)}</span>
          ${action}
        </div>
      </div>`;
    }
    // Registered directories (user-added)
    for (const d of data.registered || []) {
      items.push(sourceRow(
        d,
        `<button class="btn" data-remove-source data-path="${esc(d.path)}" data-type="${esc(d.type)}" style="font-size:11px">x</button>`,
      ));
    }
    // Auto-discovered directories (filesystem)
    const discovered = data.discovered || [];
    for (const d of discovered) {
      const action = d.status === "ok"
        ? `<button class="btn" data-import-source data-path="${esc(d.normalized_path || d.path)}" data-type="${esc(d.type)}" data-label="${esc(d.display_name || d.detected_name || "")}" style="font-size:11px">Import</button>`
        : `<button class="btn" data-remove-source data-path="${esc(d.normalized_path || d.path)}" data-type="${esc(d.type)}" style="font-size:11px">x</button>`;
      items.push(sourceRow(d, action));
    }
    // Remote synced devices
    const remote = data.remote || [];
    if (remote.length > 0) {
      items.push(`<div style="font-size:11px;color:#64748b;padding:12px 0 4px;text-transform:uppercase;letter-spacing:0.05em">Remote Devices</div>`);
      for (const d of remote) {
        items.push(sourceRow(
          { ...d, type: "remote" },
          `<span class="badge badge-active" style="font-size:10px">synced</span>`,
        ));
      }
    }

    $("sourcesList").innerHTML = items.join("") || `<div class="empty"><p>No data sources found</p></div>`;
    for (const button of document.querySelectorAll("[data-remove-source]")) {
      button.addEventListener("click", () => {
        removeSource(button.dataset.path, button.dataset.type);
      });
    }
    for (const button of document.querySelectorAll("[data-import-source]")) {
      button.addEventListener("click", () => {
        importSource(button.dataset.path, button.dataset.type, button.dataset.label);
      });
    }
    const total = (data.registered?.length || 0) + (data.discovered?.length || 0) + (data.remote?.length || 0);
    $("sourcesSummary").textContent = message || `${total} source${total !== 1 ? "s" : ""}`;
    return data;
  } catch (e) {
    $("sourcesList").innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
    return null;
  }
}

$("srcAdd").addEventListener("click", async () => {
  const path = $("srcPath").value.trim();
  const type = $("srcType").value;
  const label = $("srcLabel").value.trim();
  if (!path) return;
  await importSource(path, type, label);
});

async function importSource(path, type, label = "") {
  try {
    const res = await fetch("/api/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, type, label }),
    });
    if (!res.ok) throw new Error(await res.text());
    const result = await res.json();
    const info = result.inspection;
    if (info) $("sourcesSummary").textContent = `${info.status}: ${info.message}`;
    $("srcPath").value = "";
    $("srcLabel").value = "";
    await loadSources();
    // Refresh dashboard data
    refresh().catch(() => {});
  } catch (e) {
    $("sourcesSummary").textContent = e.message;
  }
}

async function removeSource(path, type) {
  try {
    const res = await fetch(`/api/sources?path=${encodeURIComponent(path)}&type=${encodeURIComponent(type)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    await loadSources();
    refresh().catch(() => {});
  } catch (e) {
    $("sourcesSummary").textContent = e.message;
  }
}

/* ── Skill Sync Panel ────────────────────── */

let skillSyncSelections = {}; // name -> "push" | "pull" | null

$("skillSyncBtn").addEventListener("click", () => {
  const panel = $("skillSyncPanel");
  if (panel.style.display === "none") {
    panel.style.display = "";
    $("skillSyncServer").value = syncServerUrl || "";
    $("skillSyncList").innerHTML = "";
    $("skillSyncActions").style.display = "none";
    $("skillSyncSummary").textContent = "";
  } else {
    panel.style.display = "none";
  }
});

$("skillSyncCompare").addEventListener("click", async () => {
  const serverUrl = $("skillSyncServer").value.trim() || syncServerUrl;
  if (!serverUrl) { $("skillSyncSummary").textContent = "Enter a server URL"; return; }

  $("skillSyncSummary").textContent = "Comparing…";
  try {
    const res = await fetch("/api/skills/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: serverUrl }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const comparison = data.comparison || [];
    if (!comparison.length) {
      $("skillSyncList").innerHTML = `<div class="empty"><p>No skills found. Register a third-party skill directory in Sources panel first.</p></div>`;
      $("skillSyncActions").style.display = "none";
      $("skillSyncSummary").textContent = "0 skills";
      return;
    }

    skillSyncSelections = {};
    let localCount = 0, remoteCount = 0;
    const rows = comparison.map((item) => {
      const badge =
        item.status === "same" ? `<span class="badge badge-ok" style="font-size:10px">same</span>`
        : item.status === "newer" ? `<span class="badge badge-active" style="font-size:10px">local newer</span>`
        : item.status === "older" ? `<span class="badge badge-idle" style="font-size:10px">remote newer</span>`
        : item.status === "local-only" ? `<span class="badge badge-active" style="font-size:10px">local only</span>`
        : `<span class="badge badge-idle" style="font-size:10px">remote only</span>`;

      // Determine available actions
      const canPush = item.status === "newer" || item.status === "local-only";
      const canPull = item.status === "older" || item.status === "remote-only";
      if (canPush) { skillSyncSelections[item.name] = "push"; localCount++; }
      else if (canPull) { skillSyncSelections[item.name] = "pull"; remoteCount++; }
      else skillSyncSelections[item.name] = null;

      const actionHtml = canPush
        ? `<button class="btn sync-action-btn" data-name="${esc(item.name)}" data-dir="push" style="font-size:11px;padding:2px 8px">Push ▲</button>`
        : canPull
        ? `<button class="btn sync-action-btn" data-name="${esc(item.name)}" data-dir="pull" style="font-size:11px;padding:2px 8px">Pull ▼</button>`
        : "";

      return `<div class="row" style="align-items:center">
        <div>
          <div class="row-title">${esc(item.name)} ${badge}</div>
          <div class="row-detail">${item.local ? `local: ${item.local.last_modified?.slice(0,10) || "?"}` : "no local"} · ${item.remote ? `remote: ${item.remote.last_modified?.slice(0,10) || "?"}` : "no remote"}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">${actionHtml}</div>
      </div>`;
    });

    $("skillSyncList").innerHTML = rows.join("");
    $("skillSyncActions").style.display = "flex";
    $("skillSyncSummary").textContent = `${comparison.length} skills · ${localCount} push · ${remoteCount} pull`;

    // Bind action buttons
    $("skillSyncList").querySelectorAll(".sync-action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.name;
        const dir = btn.dataset.dir;
        skillSyncSelections[name] = dir;
        // Highlight selected, dim others
        $("skillSyncList").querySelectorAll(".sync-action-btn").forEach((b) => {
          b.style.opacity = b.dataset.name === name ? "1" : "0.5";
        });
        // Also allow toggling
        if (skillSyncSelections[name] === dir) {
          btn.style.opacity = "1";
        }
      });
    });
  } catch (err) {
    $("skillSyncSummary").textContent = "Error: " + err.message;
  }
});

$("skillSyncApply").addEventListener("click", async () => {
  const serverUrl = $("skillSyncServer").value.trim() || syncServerUrl;
  const token = syncToken || localStorage.getItem("syncToken") || "";
  const pushNames = Object.entries(skillSyncSelections).filter(([, v]) => v === "push").map(([k]) => k);
  const pullNames = Object.entries(skillSyncSelections).filter(([, v]) => v === "pull").map(([k]) => k);

  if (!pushNames.length && !pullNames.length) {
    $("skillSyncSummary").textContent = "No skills selected";
    return;
  }

  $("skillSyncApply").disabled = true;
  try {
    if (pushNames.length) {
      $("skillSyncSummary").textContent = `Pushing ${pushNames.length} skill(s)…`;
      const res = await fetch("/api/skills/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server: serverUrl, names: pushNames, token }),
      });
      const data = await res.json();
      const ok = data.results?.filter((r) => r.ok).length || 0;
      toast(`Pushed ${ok}/${pushNames.length} skills`, "success");
    }
    if (pullNames.length) {
      $("skillSyncSummary").textContent = `Pulling ${pullNames.length} skill(s)…`;
      const res = await fetch("/api/skills/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server: serverUrl, names: pullNames }),
      });
      const data = await res.json();
      const ok = data.results?.filter((r) => r.ok).length || 0;
      toast(`Pulled ${ok}/${pullNames.length} skills`, "success");
    }
    $("skillSyncPanel").style.display = "none";
  } catch (err) {
    toast("Skill sync failed: " + err.message, "error");
  } finally {
    $("skillSyncApply").disabled = false;
  }
});

$("skillSyncCancel").addEventListener("click", () => {
  $("skillSyncPanel").style.display = "none";
});

