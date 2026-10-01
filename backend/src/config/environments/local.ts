import type { AppConfig } from "../types.js";

export const localConfig: AppConfig = {
  env: "local",
  port: 3000,
  logLevel: "debug",
  aws: {
    region: "us-east-1",
  },
  dynamodb: {
    tableName: "minerva-local",
    endpoint: "http://localhost:8000",
  },
};
