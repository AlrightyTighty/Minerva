import { describe, expect, it } from "vitest";
import { createProductionConfig } from "../../src/config/environments/production.js";

const deployed = {
  AWS_REGION: "us-east-2",
  TABLE_NAME: "BackendStack-DatebaseTable-ABC",
  RAW_BUCKET: "backendstack-userfilebucket-xyz",
  PROCESSED_BUCKET: "backendstack-processedbucket-xyz",
  KNOWLEDGE_BASE_ID: "KB12345678",
  CHAT_MODEL_ID: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  MATCH_MODEL_ID: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  WORK_PLAN_MODEL_ID: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  JWT_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-east-2:123456789012:secret:jwt-key-AbCdEf",
};

describe("createProductionConfig", () => {
  it("takes the table, buckets, knowledge base, model and region from the environment the stack sets", () => {
    const config = createProductionConfig(deployed);

    expect(config.env).toBe("production");
    expect(config.aws.region).toBe("us-east-2");
    expect(config.dynamodb.tableName).toBe("BackendStack-DatebaseTable-ABC");
    expect(config.s3.rawBucket).toBe("backendstack-userfilebucket-xyz");
    expect(config.s3.processedBucket).toBe("backendstack-processedbucket-xyz");
    expect(config.bedrock.knowledgeBaseId).toBe("KB12345678");
    expect(config.bedrock.chatModelId).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(config.bedrock.matchModelId).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(config.bedrock.workPlanModelId).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  it("points at the secret that holds the signing key, and never at the key itself", () => {
    const { auth } = createProductionConfig(deployed);

    expect(auth.jwtKeySecretArn).toBe("arn:aws:secretsmanager:us-east-2:123456789012:secret:jwt-key-AbCdEf");
    expect(JSON.stringify(auth)).not.toMatch(/BEGIN|PRIVATE KEY/);
    expect(auth).not.toHaveProperty("jwtPrivateKey");
  });

  it("issues short-lived access tokens, for this API and its app", () => {
    const { auth } = createProductionConfig(deployed);

    expect(auth.accessTokenTtlSeconds).toBe(900);
    expect(auth.issuer).toBe("minerva-api");
    expect(auth.audience).toBe("minerva-app");
  });

  it("never points at a local DynamoDB", () => {
    expect(createProductionConfig(deployed).dynamodb.endpoint).toBeUndefined();
  });

  it.each(Object.keys(deployed))("fails fast, naming %s, when it is missing", (name) => {
    const env: Record<string, string> = { ...deployed };
    delete env[name];

    expect(() => createProductionConfig(env)).toThrow(name);
  });
});
