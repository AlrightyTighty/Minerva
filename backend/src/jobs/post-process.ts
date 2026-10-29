import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { BedrockSummarizer } from "../clients/summarizer.js";
import { SqsIngestionQueue } from "../clients/ingestion-queue.js";
import { S3ObjectStore } from "../clients/object-store.js";
import type { PostProcessEvent } from "../models/events.js";
import { FilesRepository } from "../repositories/files.repository.js";
import { ProcessedHashesRepository } from "../repositories/processed-hashes.repository.js";
import { PostProcessService } from "../services/post-process.service.js";
import { createJobDynamoClient, requireEnv } from "./env.js";

const dynamo = createJobDynamoClient();
const tableName = requireEnv("TABLE_NAME");

const service = new PostProcessService({
  files: new FilesRepository(dynamo, tableName),
  hashes: new ProcessedHashesRepository(dynamo, tableName),
  objects: new S3ObjectStore(new S3Client({})),
  summarizer: new BedrockSummarizer(new BedrockRuntimeClient({}), requireEnv("SUMMARY_MODEL_ID")),
  queue: new SqsIngestionQueue(new SQSClient({}), requireEnv("INGEST_QUEUE_URL")),
  bdaOutputBucket: requireEnv("BDA_OUTPUT_BUCKET"),
  processedBucket: requireEnv("PROCESSED_BUCKET"),
  kbSourceBucket: requireEnv("KB_SOURCE_BUCKET"),
});

export const handler = async (event: PostProcessEvent): Promise<void> => {
  // logged in full: the BDA event shape was written from the docs, so real events are the source of truth
  console.log(JSON.stringify({ job: "post-process", event }));
  const outcome = await service.handle(event);
  console.log(JSON.stringify({ job: "post-process", outcome }));
};
