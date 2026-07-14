import { spawn } from "node:child_process";

function normalizeWindow(window) {
  if (!window) return null;
  const usedPercent = window.usedPercent ?? window.used_percent;
  const windowMinutes = window.windowDurationMins ?? window.window_minutes;
  const resetsAt = window.resetsAt ?? window.resets_at;
  return {
    used_percent: Number.isFinite(Number(usedPercent)) ? Number(usedPercent) : null,
    window_minutes: Number.isFinite(Number(windowMinutes)) ? Number(windowMinutes) : null,
    resets_at_epoch: Number.isFinite(Number(resetsAt)) ? Number(resetsAt) : null,
    resets_at: Number.isFinite(Number(resetsAt))
      ? new Date(Number(resetsAt) * 1000).toISOString()
      : null,
  };
}

export function normalizeRateLimitSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    limit_id: snapshot.limitId ?? snapshot.limit_id ?? null,
    limit_name: snapshot.limitName ?? snapshot.limit_name ?? null,
    plan_type: snapshot.planType ?? snapshot.plan_type ?? null,
    primary: normalizeWindow(snapshot.primary),
    secondary: normalizeWindow(snapshot.secondary),
    credits: snapshot.credits ?? null,
    individual_limit: snapshot.individualLimit ?? snapshot.individual_limit ?? null,
    reached_type: snapshot.rateLimitReachedType ?? snapshot.rate_limit_reached_type ?? null,
  };
}

export function normalizeRateLimitsResponse(response = {}) {
  const rawBuckets = response.rateLimitsByLimitId || response.rate_limits_by_limit_id || {};
  const rawDefault = rawBuckets.codex || response.rateLimits || response.rate_limits || null;
  const buckets = Object.fromEntries(
    Object.entries(rawBuckets).map(([id, snapshot]) => [id, normalizeRateLimitSnapshot(snapshot)]),
  );
  return {
    limits: normalizeRateLimitSnapshot(rawDefault),
    limit_buckets: buckets,
    reset_credits: response.rateLimitResetCredits || response.rate_limit_reset_credits || null,
  };
}

export class CodexLimitsClient {
  constructor({ command = process.env.CODEX_CLI_PATH || "codex", timeoutMs = 10_000 } = {}) {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.startPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
  }

  async start() {
    if (this.child) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const child = spawn(this.command, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.handleStdout(chunk));
      child.stderr.on("data", (chunk) => {
        this.stderrBuffer = (this.stderrBuffer + chunk).slice(-2_000);
      });
      child.once("error", (error) => this.handleExit(error));
      child.once("exit", (code) => this.handleExit(new Error(`Codex app-server exited with code ${code}`)));

      await this.requestRaw("initialize", {
        clientInfo: {
          name: "codex-usage-dashboard",
          title: "Codex Usage Dashboard",
          version: "0.2.0",
        },
      });
      this.send({ method: "initialized" });
    })().catch((error) => {
      this.close();
      throw error;
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not available");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  requestRaw(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || message.id === null) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex app-server request failed"));
      else pending.resolve(message.result);
    }
  }

  handleExit(error) {
    if (!this.child && !this.pending.size) return;
    const detail = this.stderrBuffer.trim();
    const failure = detail ? new Error(`${error.message}: ${detail}`) : error;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
  }

  async readRateLimits() {
    await this.start();
    return normalizeRateLimitsResponse(await this.requestRaw("account/rateLimits/read"));
  }

  close() {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
  }
}
