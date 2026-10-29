import { BedrockAgentClient } from "@aws-sdk/client-bedrock-agent";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { SQSEvent } from "aws-lambda";
import { SqsIngestionQueue } from "../clients/ingestion-queue.js";
import { BedrockKnowledgeBase } from "../clients/knowledge-base.js";
import type { IngestionMessage } from "../models/events.js";
import { FilesRepository } from "../repositories/files.repository.js";
import { IngestService } from "../services/ingest.service.js";
import { createJobDynamoClient, requireEnv } from "./env.js";

const service = new IngestService({
  files: new FilesRepository(createJobDynamoClient(), requireEnv("TABLE_NAME")),
  knowledgeBase: new BedrockKnowledgeBase(
    new BedrockAgentClient({}),
    requireEnv("KNOWLEDGE_BASE_ID"),
    requireEnv("DATA_SOURCE_ID"),
  ),
  queue: new SqsIngestionQueue(new SQSClient({}), requireEnv("INGEST_QUEUE_URL")),
});

export const handler = async (event: SQSEvent): Promise<void> => {
  const messages = event.Records.map((record) => JSON.parse(record.body) as IngestionMessage);
  await service.handleBatch(messages);
  console.log(JSON.stringify({ job: "ingest", messages: messages.map((m) => m.kind) }));
};
