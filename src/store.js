// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the stop after the panel refused the user code, with the
// address it belongs to, so a restart never sends a refused code again (an
// INTEGRA may raise an alarm or lock the keypads after wrong codes). Never
// the code itself, nor anything derived from it (a short code is brute-forced
// from any hash). The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';

export const STATE_FILE = '/data/satel-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        // A state file is a few dozen bytes: anything big is not ours.
        return text.length > 4096 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** In-memory store, for the tests. */
export function memoryStore(initial = null) {
  let data = initial;
  return {
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(next) {
      data = JSON.parse(JSON.stringify(next));
    },
    get data() {
      return data;
    },
  };
}

/** The persisted state, repaired: { codeStop: { place, at } | null }. */
export function normalizeMemory(raw) {
  const stop = raw?.codeStop;
  const valid =
    typeof stop?.place === 'string' && stop.place.length > 0 && stop.place.length <= 300;
  return {
    codeStop: valid ? { place: stop.place, at: Number.isFinite(stop.at) ? stop.at : 0 } : null,
  };
}
