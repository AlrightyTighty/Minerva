import { BedrockDataAutomationRuntimeClient } from "@aws-sdk/client-bedrock-data-automation-runtime";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import type { S3Event } from "aws-lambda";
import { BdaDocumentParser } from "../clients/document-parser.js";
import { S3ObjectStore } from "../clients/object-store.js";
import { LambdaPostProcessInvoker } from "../clients/post-process-invoker.js";
import { FilesRepository } from "../repositories/files.repository.js";
import { ProcessedHashesRepository } from "../repositories/processed-hashes.repository.js";
import { StartParseService } from "../services/start-parse.service.js";
import { createJobDynamoClient, requireEnv } from "./env.js";

const dynamo = createJobDynamoClient();
const tableName = requireEnv("TABLE_NAME");

const service = new StartParseService({
  files: new FilesRepository(dynamo, tableName),
  hashes: new ProcessedHashesRepository(dynamo, tableName),
  objects: new S3ObjectStore(new S3Client({})),
  parser: new BdaDocumentParser(
    new BedrockDataAutomationRuntimeClient({}),
    requireEnv("BDA_PROJECT_ARN"),
    requireEnv("BDA_PROFILE_ARN"),
  ),
  postProcess: new LambdaPostProcessInvoker(new LambdaClient({}), requireEnv("POST_PROCESS_FUNCTION_NAME")),
  rawBucket: requireEnv("RAW_BUCKET"),
  bdaOutputBucket: requireEnv("BDA_OUTPUT_BUCKET"),
});

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    // S3 event keys are URL encoded, with spaces as "+"
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const outcome = await service.handleUpload(key);
    console.log(JSON.stringify({ job: "start-parse", key, outcome }));
  }
};
