import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_STATE_PATH = "state/latest.json";

export async function writeStateFile(snapshot, path = DEFAULT_STATE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
