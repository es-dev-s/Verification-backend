import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const from = "src/lib";
const to = "dist/lib";
mkdirSync(to, { recursive: true });
for (const name of readdirSync(from)) {
  if (!name.endsWith(".json")) continue;
  copyFileSync(join(from, name), join(to, name));
}
