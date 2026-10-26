import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { root } from "./runtime-files.mjs";

/** Read only the fixed result file from a fresh harness directory directly below .local. */
export async function readHarnessResult(summary, prefix) {
  const local = join(root, ".local"), directory = summary?.artifacts;
  if (summary?.passed !== true || typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory
    || dirname(directory) !== local || !basename(directory).startsWith(prefix)
    || !/^[a-zA-Z0-9-]{6,}$/.test(basename(directory).slice(prefix.length))) throw new Error("ACCEPTANCE_ARTIFACT_PATH_INVALID");
  const localInfo = await lstat(local), directoryInfo = await lstat(directory);
  if (!localInfo.isDirectory() || localInfo.isSymbolicLink() || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || dirname(await realpath(directory)) !== await realpath(local)) throw new Error("ACCEPTANCE_ARTIFACT_PATH_INVALID");
  const resultFile = join(directory, "result.json"), resultInfo = await lstat(resultFile);
  if (!resultInfo.isFile() || resultInfo.isSymbolicLink() || resultInfo.size > 1024 * 1024) throw new Error("ACCEPTANCE_ARTIFACT_FILE_INVALID");
  return JSON.parse(await readFile(resultFile, "utf8"));
}
