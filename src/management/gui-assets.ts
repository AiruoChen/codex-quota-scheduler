/** Explicit browser entry points. Never expose arbitrary compiled backend files over HTTP. */
export const browserModules = ["app", "api", "dom", "labels", "context", "state", "shell", "overview", "queue", "recovery", "tasks", "runs", "settings"] as const;
