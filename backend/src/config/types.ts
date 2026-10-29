export type AppEnv = "local" | "production";

export interface AppConfig {
  env: AppEnv;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  aws: {
    region: string;
  };
  dynamodb: {
    tableName: string;
    endpoint?: string;
  };
  s3: {
    /** Bucket that uploads are presigned for, and where uploaded images are read from. */
    rawBucket: string;
    /** Bucket holding each file's processed Markdown. */
    processedBucket: string;
  };
  auth: {
    /** The Secrets Manager secret holding the JWT signing key. Production only: a local run makes its own key. */
    jwtKeySecretArn?: string;
    issuer: string;
    audience: string;
    /** How long an access token lasts. Short, since it cannot be revoked. */
    accessTokenTtlSeconds: number;
  };
  bedrock: {
    knowledgeBaseId: string;
    /** Model (or inference profile) id the chat uses. */
    chatModelId: string;
    /** A cheap model, for small structured tasks such as matching course names. */
    matchModelId: string;
    /** The model that makes work plans. Planning needs real reasoning, so this is not the cheap one. */
    workPlanModelId: string;
  };
}
