import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyBundle } from "./lib/release-bundle.mjs";
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--directory", "--channel", "--manual", "--commit"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("RELEASE_ARGUMENT_INVALID");
  options[args[i]] = args[i + 1];
}
if (!options["--directory"] || !["candidate", "stable"].includes(options["--channel"] ?? "candidate")) throw new Error("RELEASE_ARGUMENT_INVALID");
const result = await verifyBundle(resolve(options["--directory"]), { channel: options["--channel"] ?? "candidate", expectedCommit: options["--commit"],
  manual: options["--manual"] ? JSON.parse(await readFile(options["--manual"], "utf8")) : null });
console.log(JSON.stringify({ verified: true, ...result }));
