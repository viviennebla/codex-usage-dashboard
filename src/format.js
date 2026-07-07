function fmtNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function fmtMoney(value) {
  if (value === null || value === undefined) return "N/A";
  return `$${Number(value || 0).toFixed(2)}`;
}

function bar(ratio, width = 32) {
  const clamped = Math.max(0, Math.min(1, ratio || 0));
  const filled = Math.round(clamped * width);
  return `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
}

function line(label, value, ratio, detail = "") {
  const pct = `${Math.round((ratio || 0) * 1000) / 10}%`.padStart(6);
  return `${label.padEnd(14)} ${bar(ratio)} ${pct} ${value}${detail ? `  ${detail}` : ""}`;
}

function environmentLabel(row = {}) {
  if (row.environment === "wsl") return `WSL ${row.distro || ""}`.trim();
  if (row.environment === "windows") return "Windows";
  return row.environment || "unknown";
}

export function formatCli(snapshot) {
  const today = snapshot.today;
  const totals = snapshot.totals || {};
  const active = snapshot.active_session;
  const forecast = snapshot.forecast || {};
  const limits = snapshot.limits || {};
  const topProject = snapshot.top_projects?.[0];
  const primaryLimit = Number(limits.primary?.used_percent || 0) / 100;
  const secondaryLimit = Number(limits.secondary?.used_percent || 0) / 100;

  const lines = [
    "CODEX USAGE DASHBOARD",
    `[ ${snapshot.confidence} | generated ${snapshot.generated_at} ]`,
    "",
  ];

  if (today) {
    lines.push(`Today ${today.date}`);
    lines.push(line("Input", fmtNumber(today.inputTokens), today.inputTokens / today.totalTokens));
    lines.push(line("Cache Read", fmtNumber(today.cacheReadTokens), today.cacheReadRatio));
    lines.push(line("Output", fmtNumber(today.outputTokens), today.outputRatio));
    lines.push(line("Reasoning", fmtNumber(today.reasoningOutputTokens), today.reasoningRatio));
    lines.push(`Total          ${fmtNumber(today.totalTokens)} tokens  ${fmtMoney(today.costUSD)}`);
  } else {
    lines.push("No usage data for today.");
  }

  if (limits.primary || limits.secondary) {
    lines.push("");
    lines.push("Rate Limits");
    if (limits.primary) {
      const reset = limits.primary.resets_at ? `resets ${limits.primary.resets_at}` : "";
      const window = limits.primary.window_minutes ? `${limits.primary.window_minutes}m window` : "";
      lines.push(line("Primary", window, primaryLimit, reset));
    }
    if (limits.secondary) {
      const reset = limits.secondary.resets_at ? `resets ${limits.secondary.resets_at}` : "";
      const window = limits.secondary.window_minutes ? `${limits.secondary.window_minutes}m window` : "";
      lines.push(line("Secondary", window, secondaryLimit, reset));
    }
    if (limits.plan_type) lines.push(`Plan           ${limits.plan_type}`);
  }

  lines.push("");
  lines.push("All-Time Totals");
  lines.push(`Tokens         ${fmtNumber(totals.totalTokens)}`);
  lines.push(`Cost           ${fmtMoney(totals.costUSD)}`);

  if (active) {
    lines.push("");
    lines.push(active.is_active ? "Active Session" : "Latest Session");
    lines.push(`Session        ${active.displayName || active.sessionFile || active.sessionId}`);
    if (active.threadName && active.sessionFile) lines.push(`File           ${active.sessionFile}`);
    lines.push(`Environment    ${environmentLabel(active)}`);
    lines.push(`Project        ${active.projectName || "unknown"}`);
    lines.push(`Last Activity  ${active.lastActivity || "unknown"}`);
    if (active.idle_minutes != null) lines.push(`Idle           ${fmtNumber(active.idle_minutes)} minutes`);
    lines.push(`Tokens         ${fmtNumber(active.totalTokens)}  ${fmtMoney(active.costUSD)}`);
    lines.push(`Burn Rate      ${fmtNumber(active.burn_rate?.tokens_per_minute_15m)} tok/min 15m, ${fmtNumber(active.burn_rate?.tokens_per_minute_60m)} tok/min 60m`);
  }

  if (topProject) {
    lines.push("");
    lines.push("Top Project");
    lines.push(`Project        ${topProject.projectName || "unknown"}`);
    lines.push(`Environment    ${environmentLabel(topProject)}`);
    lines.push(`Tokens         ${fmtNumber(topProject.totalTokens)}`);
    if (topProject.projectPath) lines.push(`Path           ${topProject.projectPath}`);
  }

  if (forecast.averageDailyTokens != null) {
    lines.push("");
    lines.push("Forecast");
    lines.push(`Daily Average  ${fmtNumber(forecast.averageDailyTokens)} tokens`);
    lines.push(`30-Day Runway  ${fmtNumber(forecast.projectedMonthlyTokens)} tokens`);
  }

  return lines.join("\n");
}
