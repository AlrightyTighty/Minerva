import type { AppConfig } from "../types.js";

export const productionConfig: AppConfig = {
  env: "production",
  port: 3000,
  logLevel: "info",
  aws: {
    region: "us-east-1",
  },
  dynamodb: {
    tableName: "minerva-prod",
  },
};
