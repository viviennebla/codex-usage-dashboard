import { stat } from "node:fs/promises";

/**
 * Keeps parsed JSONL results for unchanged files during the web server lifetime.
 * A changed file is always reparsed from the beginning because Codex usage can
 * contain cumulative token counters that depend on earlier lines in the file.
 */
export class FileParseCache {
  #entries = new Map();

  async get(namespace, file, context, parse) {
    const info = await stat(file);
    const key = `${namespace}\u0000${file}`;
    const previous = this.#entries.get(key);
    if (
      previous &&
      previous.size === info.size &&
      previous.mtimeMs === info.mtimeMs &&
      previous.context === context
    ) {
      return previous.value;
    }

    const value = await parse();
    this.#entries.set(key, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      context,
      value,
    });
    return value;
  }

  prune(namespace, files) {
    const current = new Set(files);
    const prefix = `${namespace}\u0000`;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix) && !current.has(key.slice(prefix.length))) {
        this.#entries.delete(key);
      }
    }
  }
}
