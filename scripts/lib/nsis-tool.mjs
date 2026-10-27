import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, lstat, readFile, writeFile, stat, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./runtime-files.mjs";

// Electron builder's maintained NSIS 3.12 bundle; immutable release digest, no global compiler installation.
export const nsisRelease = {
  version: "3.12", url: "https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis%402.0.1/nsis-bundle-3.12.tar.gz",
  sha256: "fe36a357f3a220db893498e830fd80e0769768a18a99f4e4d2447b982538feed",
};
export async function nsisCompiler() {
  const directory = join(root, ".tmp/nsis-tool");
  await mkdir(directory, { recursive: true });
  const archive = join(directory, "bundle.tar.gz");
  let bytes;
  try { bytes = await readFile(archive); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const downloaded = !bytes;
  if (downloaded) {
    const response = await fetch(nsisRelease.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error("NSIS compiler download failed");
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(bytes).digest("hex") !== nsisRelease.sha256) throw new Error("NSIS compiler archive checksum mismatch");
  if (downloaded) {
    const temporary = archive + "." + randomUUID() + ".tmp";
    try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, archive); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  // Extract afresh so compiler and plugins come from the same verified archive.
  const destination = await mkdtemp(join(directory, "verified-"));
  execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/tar.exe"), ["-xf", archive, "-C", destination], { windowsHide: true });
  const compiler = join(destination, "nsis-bundle/windows/makensis.exe");
  if (!(await stat(compiler)).isFile()) throw new Error("NSIS compiler missing");
  return compiler;
}
export async function installerFiles(directory) {
  const paths = (await readdir(directory, { recursive: true })).sort();
  const files = [];
  for (const path of paths) {
    const item = await lstat(join(directory, path));
    if (item.isSymbolicLink()) throw new Error("Installer inputs cannot contain symlinks");
    if (item.isFile()) files.push(path.replaceAll("\\", "/"));
  }
  return files;
}
