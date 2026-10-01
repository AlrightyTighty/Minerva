import type { AppConfig, AppEnv } from "./types.js";
import { localConfig } from "./environments/local.js";
import { developmentConfig } from "./environments/development.js";
import { productionConfig } from "./environments/production.js";

const configsByEnv: Record<AppEnv, AppConfig> = {
  local: localConfig,
  development: developmentConfig,
  production: productionConfig,
};

function resolveEnv(): AppEnv {
  const raw = process.env.APP_ENV ?? "local";
  if (raw in configsByEnv) {
    return raw as AppEnv;
  }
  throw new Error(`Unknown APP_ENV "${raw}". Expected one of: ${Object.keys(configsByEnv).join(", ")}`);
}

export const config: AppConfig = configsByEnv[resolveEnv()];

export type { AppConfig, AppEnv } from "./types.js";
