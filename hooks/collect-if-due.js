import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { collectDenglemaSnapshot } from "../src/denglema.js";
import { resolveDenglemaDataDir } from "../src/denglema-snapshot.js";

async function recordHookError(error) {
  try {
    const dataDir = resolveDenglemaDataDir();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "last-hook-error.json"), JSON.stringify({
      at: new Date().toISOString(),
      message: error?.message || String(error),
    }, null, 2) + "\n", "utf8");
  } catch {}
}

async function main() {
  try {
    const result = await collectDenglemaSnapshot();
    if (!result.collected || !result.snapshot) return;

    const tokens = Number(result.snapshot.total_tokens || 0).toLocaleString("en-US");
    process.stdout.write(JSON.stringify({
      continue: true,
      systemMessage: `蹬了吗：本地快照已更新到 ${tokens} tokens，尚未上传。需要上传时说“上传蹬了吗”。`,
    }));
  } catch (error) {
    await recordHookError(error);
  }
}

await main();
