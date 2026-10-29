import type { AppConfig } from "../types.js";

export const localConfig: AppConfig = {
  env: "local",
  port: 3000,
  logLevel: "debug",
  aws: {
    region: "us-east-2",
  },
  dynamodb: {
    tableName: "minerva-local",
  },
  s3: {
    rawBucket: process.env.RAW_BUCKET ?? "minerva-local-raw",
    processedBucket: process.env.PROCESSED_BUCKET ?? "minerva-local-processed",
  },
  auth: {
    issuer: "minerva-api",
    audience: "minerva-app",
    accessTokenTtlSeconds: 15 * 60,
  },
  bedrock: {
    knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID ?? "",
    chatModelId: process.env.CHAT_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    matchModelId: process.env.MATCH_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    workPlanModelId: process.env.WORK_PLAN_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
};
