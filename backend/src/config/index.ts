import type { AppConfig, AppEnv } from "./types.js";
import { localConfig } from "./environments/local.js";
import { createProductionConfig } from "./environments/production.js";

// built lazily: production needs the deployed environment variables, which do not exist when running locally
const configsByEnv: Record<AppEnv, () => AppConfig> = {
  local: () => localConfig,
  production: () => createProductionConfig(),
};

function resolveEnv(): AppEnv {
  const raw = process.env.APP_ENV ?? "local";
  if (raw in configsByEnv) {
    return raw as AppEnv;
  }
  throw new Error(`Unknown APP_ENV "${raw}". Expected one of: ${Object.keys(configsByEnv).join(", ")}`);
}

export const config: AppConfig = configsByEnv[resolveEnv()]();

export type { AppConfig, AppEnv } from "./types.js";
