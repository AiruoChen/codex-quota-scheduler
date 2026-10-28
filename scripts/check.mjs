import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";

// Release assembly, installers and Electron all consume this version.
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version) {
  throw new Error("Package and lockfile versions must match");
}
await readFile(`docs/RELEASE-NOTES-${manifest.version}.md`, "utf8");

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
// Browser runtime imports stay inside the GUI. Backend contracts are imported only as types.
for (const file of await readdir("src/management/gui")) {
  if (!file.endsWith(".ts")) continue;
  const source = ts.createSourceFile(file, await readFile(join("src/management/gui", file), "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      if (!ts.isStringLiteral(node.moduleSpecifier) || !/^\.\/[a-z-]+\.js$/.test(node.moduleSpecifier.text)) throw new Error(`Invalid browser runtime import: ${file}`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`Dynamic browser import is not allowed: ${file}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
console.log("Package version, release notes, JavaScript syntax, domain/scheduler and browser module boundaries checked.");
