import { spawn } from "node:child_process";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function epochToIso(value) {
  const epoch = finiteNumber(value);
  return epoch === null ? null : new Date(epoch * 1000).toISOString();
}

function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  const resetsAt = window.resets_at ?? window.resetsAt ?? null;
  const resetsEpoch = finiteNumber(window.resets_at_epoch ?? (typeof resetsAt === "number" ? resetsAt : null));
  const usedPercent = finiteNumber(window.used_percent ?? window.usedPercent);
  return {
    used_percent: usedPercent ?? 0,
    window_minutes: finiteNumber(window.window_minutes ?? window.windowDurationMins),
    resets_at_epoch: resetsEpoch,
    resets_at: typeof resetsAt === "string" ? resetsAt : epochToIso(resetsEpoch),
  };
}

export function normalizeCodexStatusRateLimits(payload) {
  const snapshot = payload?.rateLimitsByLimitId?.codex || payload?.rateLimits || payload;
  if (!snapshot || typeof snapshot !== "object") return null;

  const limits = {
    limit_id: snapshot.limit_id ?? snapshot.limitId ?? "codex",
    limit_name: snapshot.limit_name ?? snapshot.limitName ?? null,
    plan_type: snapshot.plan_type ?? snapshot.planType ?? null,
    primary: normalizeWindow(snapshot.primary),
    secondary: normalizeWindow(snapshot.secondary),
    rate_limit_reached_type: snapshot.rate_limit_reached_type ?? snapshot.rateLimitReachedType ?? null,
  };

  if (!limits.primary && !limits.secondary) return null;
  return limits;
}

export function readCodexStatusRateLimits(options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const bin = options.bin || process.env.CODEX_USAGE_CODEX_BIN || "codex";

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffer = "";
    let settled = false;

    function finish(error, result = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(result);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    const timer = setTimeout(() => {
      finish(new Error("Codex status API timed out"));
    }, timeoutMs);

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Codex status API exited with code ${code}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          send({ method: "initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null });
          continue;
        }

        if (message.id === 2) {
          if (message.error) {
            finish(new Error(message.error.message || "Codex status API failed"));
            return;
          }
          const limits = normalizeCodexStatusRateLimits(message.result);
          if (!limits) {
            finish(new Error("Codex status API returned no rate limits"));
            return;
          }
          finish(null, {
            limits,
            limit_updated_at: new Date().toISOString(),
            source: "codex_status_api",
          });
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codex-usage-dashboard", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
