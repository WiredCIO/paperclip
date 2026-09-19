export type ProjectAccessMode = "off" | "shadow" | "enforce";

export function projectAccessMode(): ProjectAccessMode {
  const raw = process.env.PAPERCLIP_PROJECT_ACCESS_MODE?.trim().toLowerCase();
  if (raw === "shadow") return "shadow";
  if (raw === "enforce") return "enforce";
  return "off";
}

export type ProjectVisibilityDecision = {
  allowed: boolean;
  reason: string;
  mode: ProjectAccessMode;
};

export type ProjectVisibilityActorWithMemo = {
  __projectVisibilityMemo?: Map<string, Promise<unknown>>;
};

// Caches on the actor object itself so the memo lives no longer than the
// request/actor it was built for, and evicts on rejection so a failed lookup
// can be retried.
export function getOrCreateProjectVisibilityMemo<T>(
  actor: ProjectVisibilityActorWithMemo,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  actor.__projectVisibilityMemo ??= new Map();
  const memo = actor.__projectVisibilityMemo;

  const cached = memo.get(key);
  if (cached) return cached as Promise<T>;

  const promise = load();
  memo.set(key, promise);
  void promise.catch(() => {
    if (memo.get(key) === promise) {
      memo.delete(key);
    }
  });
  return promise;
}
