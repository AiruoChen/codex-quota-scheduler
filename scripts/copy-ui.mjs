import { cp, mkdir } from "node:fs/promises";
await mkdir(new URL("../dist/src/management/public/", import.meta.url), { recursive: true });
await cp(new URL("../src/management/public/", import.meta.url), new URL("../dist/src/management/public/", import.meta.url), { recursive: true });
await mkdir(new URL("../dist/src/desktop/public/", import.meta.url), { recursive: true });
await cp(new URL("../src/desktop/public/", import.meta.url), new URL("../dist/src/desktop/public/", import.meta.url), { recursive: true });
