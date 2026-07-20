import { rmSync } from "node:fs";

rmSync("dist-server", { recursive: true, force: true });
