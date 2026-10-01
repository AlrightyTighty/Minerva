import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AppConfig } from "../config/types.js";

export function createDynamoClient(config: AppConfig): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    region: config.aws.region,
    ...(config.dynamodb.endpoint ? { endpoint: config.dynamodb.endpoint } : {}),
  });

  return DynamoDBDocumentClient.from(client);
}
