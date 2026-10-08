import type { Env } from "./src/env";

declare global {
  namespace Cloudflare {
    interface Env extends ImportedEnv {}
  }
}

interface ImportedEnv extends Env {}
