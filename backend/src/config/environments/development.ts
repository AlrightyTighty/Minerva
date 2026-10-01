import type { AppConfig } from "../types.js";

export const developmentConfig: AppConfig = {
  env: "development",
  port: 3000,
  logLevel: "debug",
  aws: {
    region: "us-east-1",
  },
  dynamodb: {
    tableName: "minerva-dev",
  },
};
