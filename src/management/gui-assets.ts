/** Explicit browser entry points. Never expose arbitrary compiled backend files over HTTP. */
export const browserModules = ["app", "api", "dom", "labels", "context", "state", "shell", "overview", "queue", "recovery", "tasks", "runs", "settings", "native", "task-preview", "clipboard", "recovery-model", "selected-resource", "run-detail"] as const;
