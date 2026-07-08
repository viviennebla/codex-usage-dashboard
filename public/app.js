const $ = (id) => document.getElementById(id);

/* ── Helpers ─────────────────────────────── */

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

  const items = [
    metricCard("Today Tokens", fmtShort(today.totalTokens),
      `${fmtNumber(today.totalTokens)} total · ${today.eventCount || 0} events`,
      { accent: "accent" }),
    metricCard("Primary Limit", fmtPercent(primaryPct),
      limits.primary?.resets_at ? `Resets ${fmtCompactTime(limits.primary.resets_at)}` : "No sample",
      { accent: primaryClass }),
    metricCard("Burn Rate", `${fmtNumber(burn.tokens_per_minute_15m)}/min`,
      `${fmtShort(burn.tokens_15m)} tokens in 15m`,
      {}),
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

function drawTrend(snapshot) {
  const canvas = $("trend");
  const ctx = canvas.getContext("2d");
  const tooltip = $("chartTooltip");
  const rows = snapshot.recent_days || [];
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

  // Initial draw
  draw(-1);

  // ── Hover interaction ──
  canvas.onmousemove = function (e) {
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Find closest bar by X position
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < bars.length; i++) {
      const cx = bars[i].x + bars[i].w / 2;
      const dist = Math.abs(mx - cx);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }

    // Only show tooltip if within chart X-range (Y ranges vary by bar height, too restrictive)
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

function limitRow(label, pct, windowMin, resetsAt, generatedAt, planType) {
  const ratio = Math.max(0, Math.min(1, pct / 100));
  const badge = limitBadge(pct);
  const barClass = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";

  // Calculate time progress through the rate-limit window
  let timePct = null;
  let paceNote = "";
  if (resetsAt && windowMin) {
    const resetDate = new Date(resetsAt);
    const genDate = generatedAt ? new Date(generatedAt) : new Date();
    const windowStart = new Date(resetDate.getTime() - windowMin * 60000);
    const elapsed = (genDate - windowStart) / 60000;
    timePct = Math.max(0, Math.min(100, (elapsed / windowMin) * 100));
    if (timePct < 99) {
      paceNote = pct > timePct + 5
        ? ` · <span style="color:#f59e0b">⚠ ${(pct - timePct).toFixed(0)}% ahead of time</span>`
        : ` · <span style="color:#22c55e">on pace</span>`;
    }
  }

  const timeMarker = timePct != null && timePct < 99
    ? `<div class="bar-time-marker" style="left:${timePct}%" title="Time elapsed: ${timePct.toFixed(0)}%"></div>`
    : "";

  const detail = `${windowMin ? windowMin + 'm window' : ''}${resetsAt ? ' · resets ' + fmtCompactTime(resetsAt) : ''}${planType ? ' · ' + planType : ''}${paceNote}`;

  return `<div class="row">
    <div>
      <div class="row-title">${esc(label)}${badge ? ` <span class="badge badge-${esc(badge)}">${esc(badge)}</span>` : ""}</div>
      <div class="row-detail">${detail}</div>
      <div class="bar-track">
        <div class="bar-fill${barClass ? " " + barClass : ""}" style="width:${ratio * 100}%"></div>
        ${timeMarker}
        ${timePct != null && timePct < 99 ? `<div style="font-size:9px;color:var(--ink-muted);margin-top:2px">usage ${pct.toFixed(0)}% · time ${timePct.toFixed(0)}%</div>` : ""}
      </div>
    </div>
    <div class="row-value">${fmtPercent(pct)}</div>
  </div>`;
}

function renderActive(snapshot) {
  const active = snapshot.active_session;
  const limits = snapshot.limits || {};
  const generatedAt = snapshot.generated_at || null;
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
    ));
  }

  // Billing note
  rows.push(`<div class="billing-note">
    <span>Codex</span> (subscription) — rate-limited per window above ·
    <span>DeepSeek</span> (pay-per-use) — no rate limits, billed per token
  </div>`);

  $("active").innerHTML = rows.join("");
}

/* ── Render: Projects ────────────────────── */

function renderProjects(snapshot) {
  const projects = (snapshot.top_projects || []).slice(0, 6);
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

  const tokenMax = Math.max(...entries.map(([, u]) => u.totalTokens || 0), 1);
  const eventMax = Math.max(...entries.map(([, u]) => u.eventCount || 0), 1);

  // Compute bar layout: pairs side by side
  const barGap = 3;   // gap between token & request bar in same group (px)
  const groupStep = chartW / count;
  const barPairW = Math.min(groupStep - 4, 40);
  const barW = Math.max(5, (barPairW - barGap) / 2);

  const bars = entries.map(([model, usage], i) => {
    const groupX = pad.left + i * groupStep + (groupStep - barPairW) / 2;
    const tokenH = Math.max(2, (chartH * (usage.totalTokens || 0)) / tokenMax);
    const eventH = Math.max(2, (chartH * (usage.eventCount || 0)) / eventMax);
    return {
      token: {
        x: groupX,
        y: pad.top + chartH - tokenH,
        w: barW,
        h: tokenH,
      },
      request: {
        x: groupX + barW + barGap,
        y: pad.top + chartH - eventH,
        w: barW,
        h: eventH,
      },
      model,
      tokens: usage.totalTokens || 0,
      requests: usage.eventCount || 0,
      groupX,
      groupW: barPairW,
    };
  });

  function draw(highlightIdx) {
    ctx.clearRect(0, 0, W, H);

    // Background
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
      const reqVal = eventMax - (eventMax * i) / gridLines;
      ctx.fillStyle = REQUEST_COLOR;
      ctx.textAlign = "left";
      ctx.fillText(fmtShort(reqVal), W - pad.right + 8, Math.round(y));
    }

    // Bars
    bars.forEach((bar, i) => {
      const isHL = highlightIdx === i;

      // Token bar (green)
      const t = bar.token;
      ctx.fillStyle = isHL ? TOKEN_COLOR_HL : TOKEN_COLOR;
      ctx.fillRect(t.x, t.y, t.w, t.h);

      // Request bar (blue)
      const r = bar.request;
      ctx.fillStyle = isHL ? REQUEST_COLOR_HL : REQUEST_COLOR;
      ctx.fillRect(r.x, r.y, r.w, r.h);

      // Value labels on top of bars (only if tall enough)
      ctx.font = "9px 'Fira Code', ui-monospace, monospace";
      ctx.textBaseline = "bottom";
      if (t.h > 12) {
        ctx.fillStyle = "#e2e8f0";
        ctx.textAlign = "center";
        ctx.fillText(fmtShort(bar.tokens), t.x + t.w / 2, t.y - 2);
      }
      if (r.h > 12) {
        ctx.fillStyle = "#e2e8f0";
        ctx.textAlign = "center";
        ctx.fillText(fmtShort(bar.requests), r.x + r.w / 2, r.y - 2);
      }
    });

    // X-axis labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    bars.forEach((bar, i) => {
      const isHL = highlightIdx === i;
      ctx.fillStyle = isHL ? "#e2e8f0" : "#64748b";
      ctx.font = `${isHL ? "bold " : ""}10px 'Fira Code', ui-monospace, monospace`;

      // Truncate long model names
      let label = bar.model;
      if (label.length > 14) label = label.slice(0, 12) + "…";
      ctx.fillText(label, bar.groupX + bar.groupW / 2, pad.top + chartH + 8);

      // Show short value below name
      ctx.fillStyle = isHL ? "#94a3b8" : "#475569";
      ctx.font = "8px 'Fira Code', ui-monospace, monospace";
      ctx.fillText(fmtShort(bar.tokens), bar.groupX + bar.groupW / 2, pad.top + chartH + 22);
    });

    // Legend — positioned well above the tallest bars (pad.top=42, legend ends at ~y=22)
    const legendY = 6;
    ctx.font = "10px 'Fira Code', ui-monospace, monospace";
    // Tokens legend
    ctx.fillStyle = TOKEN_COLOR;
    ctx.fillRect(pad.left, legendY, 10, 10);
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "start";
    ctx.textBaseline = "middle";
    ctx.fillText("Tokens", pad.left + 14, legendY + 5);

    // Requests legend
    const reqLegendX = pad.left + 90;
    ctx.fillStyle = REQUEST_COLOR;
    ctx.fillRect(reqLegendX, legendY, 10, 10);
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "start";
    ctx.textBaseline = "middle";
    ctx.fillText("Requests", reqLegendX + 14, legendY + 5);
  }

  draw(-1);

  // ── Hover interaction ──
  canvas.onmousemove = function (e) {
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < bars.length; i++) {
      const cx = bars[i].groupX + bars[i].groupW / 2;
      const dist = Math.abs(mx - cx);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }

    const inChart = mx >= pad.left && mx <= W - pad.right && my >= 0 && my <= H;
    if (!inChart || bestIdx < 0 || bestDist > groupStep / 2 + 4) {
      tooltip.hidden = true;
      draw(-1);
      return;
    }

    const bar = bars[bestIdx];
    draw(bestIdx);

    const tx = bar.groupX + bar.groupW / 2;
    const ty = Math.min(bar.token.y, bar.request.y) - 10;

    const modelLabel = bar.model === "others" ? "Others" : bar.model;
    tooltip.hidden = false;
    tooltip.innerHTML =
      `<div class="chart-tooltip-date">${esc(modelLabel)}</div>` +
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
    $("skills").innerHTML = emptyState("No skill data");
    return;
  }
  $("skills").innerHTML = skills.map((s) =>
    usageRow(
      s.name,
      `${s.count} call${s.count !== 1 ? "s" : ""}`,
      fmtShort(s.totalTokens),
    )
  ).join("");
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
  const rows = snapshot.recent_days || [];
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

  // ── GitHub-style: columns = weeks, rows = days (Mon 0 … Sun 6) ──
  const firstDay = new Date(hmYear, hmMonth, 1);
  const lastDay = new Date(hmYear, hmMonth + 1, 0);
  const daysInMonth = lastDay.getDate();

  // Day of week for 1st: convert Sun=0 to Mon=0
  let startDow = firstDay.getDay(); // 0=Sun … 6=Sat
  startDow = startDow === 0 ? 6 : startDow - 1; // → 0=Mon … 6=Sun

  const numCols = Math.ceil((startDow + daysInMonth) / 7); // weeks in month
  const numRows = 7; // Mon … Sun

  // Layout
  const labelW = 18;
  const topH = 4;
  const legendH = 22;
  const cellGap = 3;
  const maxCellSize = 22;
  const rightPad = 8;

  const availableW = W - labelW - rightPad - 4;
  const rawStep = Math.floor(availableW / numCols);
  const cellStep = Math.min(rawStep, maxCellSize + cellGap);
  const cellSize = cellStep - cellGap;

  // Center the grid horizontally
  const gridW = numCols * cellStep;
  const gridH = numRows * cellStep;
  const gridLeft = labelW + 4 + Math.floor((availableW - gridW) / 2);
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
  for (let col = 0; col < numCols; col++) {
    for (let row = 0; row < numRows; row++) {
      const dayNum = col * 7 + row - startDow + 1; // 1-based
      if (dayNum < 1 || dayNum > daysInMonth) continue;

      const x = gridLeft + col * cellStep;
      const y = gridTop + row * cellStep;

      const mm = String(hmMonth + 1).padStart(2, "0");
      const dd = String(dayNum).padStart(2, "0");
      const dateStr = `${hmYear}-${mm}-${dd}`;

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
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
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
  $("heatmapMonth").textContent = MONTHS_FULL[hmMonth] + " " + hmYear;
}

/* ── Main Refresh ────────────────────────── */

async function refresh() {
  $("meta").textContent = "Refreshing…";
  const response = await fetch("/api/snapshot", { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  const snapshot = await response.json();

  renderMetrics(snapshot);
  drawHeatmap(snapshot);
  drawTrend(snapshot);
  renderActive(snapshot);
  renderProjects(snapshot);
  renderModels(snapshot);
  renderSkills(snapshot);
  renderSessions(snapshot);
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
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  if (!syncServerUrl) { $("syncStatus").textContent = "Save server first"; return; }
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
  } catch (err) {
    $("syncStatus").textContent = "Push failed: " + err.message;
  }
});

$("syncPull").addEventListener("click", async () => {
  if (!syncServerUrl) { $("syncStatus").textContent = "Save server first"; return; }
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
  } catch (err) {
    $("syncStatus").textContent = "Pull failed: " + err.message;
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
        drawHeatmap(snap);
        drawTrend(snap);
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

async function loadSources() {
  try {
    const res = await fetch("/api/sources");
    const data = await res.json();
    const items = [];
    // Registered directories (user-added)
    for (const d of data.registered || []) {
      items.push(`<div class="row">
        <div><div class="row-title">${esc(d.path)}</div><div class="row-detail">[${d.type}] ${d.label || ""} · ${d.addedAt || ""}</div></div>
        <button class="btn" onclick="removeSource('${esc(d.path)}','${esc(d.type)}')" style="font-size:11px">✕</button>
      </div>`);
    }
    // Auto-discovered directories (filesystem)
    const discovered = data.discovered || [];
    for (const d of discovered) {
      items.push(`<div class="row">
        <div><div class="row-title">${esc(d.path)}</div><div class="row-detail">[${d.type}] ${d.label || "auto-detected"}</div></div>
        <span class="badge badge-ok" style="font-size:10px">auto</span>
      </div>`);
    }
    $("sourcesList").innerHTML = items.join("") || `<div class="empty"><p>No data sources found</p></div>`;
    const total = (data.registered?.length || 0) + (data.discovered?.length || 0);
    $("sourcesSummary").textContent = `${total} source${total !== 1 ? "s" : ""}`;
  } catch (e) {
    $("sourcesList").innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
  }
}

$("srcAdd").addEventListener("click", async () => {
  const path = $("srcPath").value.trim();
  const type = $("srcType").value;
  if (!path) return;
  try {
    await fetch("/api/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, type }),
    });
    $("srcPath").value = "";
    await loadSources();
    // Refresh dashboard data
    refresh().catch(() => {});
  } catch (e) {
    $("sourcesSummary").textContent = e.message;
  }
});

async function removeSource(path, type) {
  try {
    await fetch(`/api/sources?path=${encodeURIComponent(path)}&type=${encodeURIComponent(type)}`, { method: "DELETE" });
    await loadSources();
    refresh().catch(() => {});
  } catch (e) {
    $("sourcesSummary").textContent = e.message;
  }
}

