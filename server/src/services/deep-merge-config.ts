/**
 * CH-18: the merge semantics `PATCH /agents/:id` applies to `runtimeConfig`.
 *
 * `adapterConfig` on that same route has always merged; `runtimeConfig` was
 * assigned wholesale, preserving only `aiConnection`. So a PATCH that set one
 * limit silently erased every other key — on S4Water, setting a turn cap wiped
 * the agent's `heartbeat` block. And because the one preserved key was
 * preserved unconditionally, `aiConnection` could not be cleared through the
 * API at all; it took a SQL update.
 *
 * The rules here fix both:
 *
 *   - a plain object merges key by key, recursively;
 *   - an explicit JSON `null` deletes the key, which is what makes
 *     `aiConnection` clearable;
 *   - everything else — scalars, arrays, dates — replaces wholesale, because a
 *     half-merged array is never what a caller meant.
 *
 * `undefined` never appears in parsed JSON, so a key the caller omitted simply
 * is not present and keeps its existing value.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Keys that must never be written through a merge, whatever the payload says. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Deep-merges `patch` onto `base`, treating `null` as a delete. Neither input
 * is mutated.
 */
export function deepMergeConfig(
  base: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(base ?? {}) };
  if (!patch) return result;

  for (const [key, value] of Object.entries(patch)) {
    // Prototype pollution: a payload key like `__proto__` arrives as an own
    // enumerable property of the parsed object, so it reaches this loop.
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value === null) {
      delete result[key];
      continue;
    }
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      const existing = result[key];
      result[key] = deepMergeConfig(isPlainObject(existing) ? existing : {}, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}
