import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Drops the table's key attributes, which are storage details and not part of the domain objects. */
export function stripKeys<T>(item: Record<string, unknown>): T {
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as T;
}

/** One logical query: every item in a partition whose sort key starts with `prefix`, following pagination. */
export async function queryByPrefix<T>(
  client: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  prefix: string,
): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(response.Items ?? []).map((item) => stripKeys<T>(item)));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}
