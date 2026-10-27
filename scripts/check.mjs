import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";

// TypeScript's noEmit check does not parse browser scripts or build/test tooling.
for (const directory of ["src", "scripts", "tests/fixtures"]) {
  for (const file of await readdir(directory, { recursive: true })) {
    if (!/\.(?:js|mjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ["--check", join(directory, file)], { stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

// Domain rules cannot depend on infrastructure; scheduling consumes domain ports.
for (const directory of ["src/domain", "src/scheduler"]) {
  for (const file of await readdir(directory, { recursive: true })) {
    if (!file.endsWith(".ts")) continue;
    const path = resolve(directory, file);
    const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (specifier) {
        if (!ts.isStringLiteral(specifier)) throw new Error(`Dynamic dependency is not allowed in ${directory}/${file}`);
        const target = resolve(dirname(path), specifier.text);
        const allowed = specifier.text.startsWith(".") && (target.startsWith(resolve("src/domain") + sep)
          || directory === "src/scheduler" && target === resolve("src/shared/errors.js"));
        if (!allowed) throw new Error(`Invalid module dependency: ${directory}/${file} -> ${specifier.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
console.log("JavaScript syntax and domain/scheduler module boundaries checked.");
