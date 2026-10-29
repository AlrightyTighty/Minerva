import type { AppConfig } from "../types.js";

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name} (the stack sets it on the API Lambda)`);
  }
  return value;
}

/** Resource names are generated at deploy time, so the stack hands them to the Lambda as environment variables. */
export function createProductionConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    env: "production",
    port: 3000,
    logLevel: "info",
    aws: {
      region: requireEnv(env, "AWS_REGION"),
    },
    dynamodb: {
      tableName: requireEnv(env, "TABLE_NAME"),
    },
    s3: {
      rawBucket: requireEnv(env, "RAW_BUCKET"),
      processedBucket: requireEnv(env, "PROCESSED_BUCKET"),
    },
    auth: {
      // the secret's ARN, never the key: the key is read from Secrets Manager when the API starts
      jwtKeySecretArn: requireEnv(env, "JWT_KEY_SECRET_ARN"),
      issuer: "minerva-api",
      audience: "minerva-app",
      accessTokenTtlSeconds: 15 * 60,
    },
    bedrock: {
      knowledgeBaseId: requireEnv(env, "KNOWLEDGE_BASE_ID"),
      chatModelId: requireEnv(env, "CHAT_MODEL_ID"),
      matchModelId: requireEnv(env, "MATCH_MODEL_ID"),
      workPlanModelId: requireEnv(env, "WORK_PLAN_MODEL_ID"),
    },
  };
}
