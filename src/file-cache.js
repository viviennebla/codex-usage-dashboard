import { open, stat } from "node:fs/promises";

const TAIL_BYTES = 256;

async function readTail(file, size) {
  if (!size) return { signature: "", appendable: true };
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await open(file, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const tail = buffer.subarray(0, bytesRead);
    const last = tail.at(-1);
    return {
      signature: tail.toString("base64"),
      appendable: last === 0x0a || last === 0x0d,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Keeps parsed JSONL results for unchanged files during the web server lifetime.
 * A changed file is always reparsed from the beginning because Codex usage can
 * contain cumulative token counters that depend on earlier lines in the file.
 */
export class FileParseCache {
  #entries = new Map();
  #metrics = { hits: 0, misses: 0, fullParses: 0, incrementalParses: 0, bytesSkipped: 0 };

  async #store(key, file, context, info, value) {
    const tail = await readTail(file, info.size);
    this.#entries.set(key, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      context,
      value,
      ...tail,
    });
    return value;
  }

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
      this.#metrics.hits += 1;
      return previous.value;
    }

    this.#metrics.misses += 1;
    this.#metrics.fullParses += 1;
    const value = await parse();
    return this.#store(key, file, context, info, value);
  }

  /**
   * Parse only bytes appended to a newline-terminated JSONL file. A prefix
   * signature prevents treating truncation or in-place rewrites as appends.
   * Both callbacks receive an inclusive byte range captured before parsing.
   */
  async getIncremental(namespace, file, context, { full, append }) {
    const info = await stat(file);
    const key = `${namespace}\u0000${file}`;
    const previous = this.#entries.get(key);
    if (
      previous &&
      previous.size === info.size &&
      previous.mtimeMs === info.mtimeMs &&
      previous.context === context
    ) {
      this.#metrics.hits += 1;
      return previous.value;
    }

    if (
      previous &&
      previous.context === context &&
      previous.appendable &&
      info.size > previous.size
    ) {
      const currentPrefixTail = await readTail(file, previous.size);
      if (currentPrefixTail.signature === previous.signature) {
        this.#metrics.incrementalParses += 1;
        this.#metrics.bytesSkipped += previous.size;
        const value = await append(previous.value, {
          start: previous.size,
          end: info.size - 1,
        });
        return this.#store(key, file, context, info, value);
      }
    }

    this.#metrics.misses += 1;
    this.#metrics.fullParses += 1;
    const value = await full({ start: 0, end: info.size - 1 });
    return this.#store(key, file, context, info, value);
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

  clear() {
    this.#entries.clear();
  }

  stats() {
    return { entries: this.#entries.size, ...this.#metrics };
  }
}
