import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));

/** Source-derived allowlist shared by CLI and desktop distributions. Never copy all of dist. */
export async function runtimeFiles({ desktop = false } = {}) {
  const sources = await readdir(join(root, "src"), { recursive: true });
  const files = sources.filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts")
    && (desktop || !path.replaceAll("\\", "/").startsWith("desktop/")))
    .flatMap((path) => [join("dist/src", path.replace(/\.ts$/, ".js")), join("dist/src", path.replace(/\.ts$/, ".js.map"))]);
  files.push(...["index.html", "app.js", "style.css"].map((name) => join("dist/src/management/public", name)),
    "config/example.json", "config/codex.example.json", "examples/tasks.json", "examples/prompts/review-project.md",
    "README.md", "launch.cmd", "launch.sh");
  if (desktop) files.push("dist/src/desktop/public/startup.html", "dist/src/desktop/public/startup.css");
  files.push(...(await readdir(join(root, "docs"))).filter((name) => name.endsWith(".md")).map((name) => join("docs", name)));
  for (const path of files) if (!(await stat(join(root, path))).isFile()) throw new Error(`Missing package input: ${path}`);
  return files;
}
