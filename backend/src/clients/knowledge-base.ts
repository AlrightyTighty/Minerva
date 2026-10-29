import { GetIngestionJobCommand, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import type { BedrockAgentClient } from "@aws-sdk/client-bedrock-agent";

export type IngestionJobStatus = "STARTING" | "IN_PROGRESS" | "COMPLETE" | "FAILED" | "STOPPING" | "STOPPED";

export interface IngestionJob {
  status: IngestionJobStatus;
  documentsFailed: number;
  failureReasons: string[];
}

export type StartIngestionResult = { started: true; jobId: string } | { started: false };

export interface KnowledgeBase {
  /** `started: false` means another job is already running on the data source. */
  startIngestion(): Promise<StartIngestionResult>;
  getIngestionJob(jobId: string): Promise<IngestionJob>;
}

export class BedrockKnowledgeBase implements KnowledgeBase {
  constructor(
    private readonly client: BedrockAgentClient,
    private readonly knowledgeBaseId: string,
    private readonly dataSourceId: string,
  ) {}

  async startIngestion(): Promise<StartIngestionResult> {
    try {
      const response = await this.client.send(
        new StartIngestionJobCommand({
          knowledgeBaseId: this.knowledgeBaseId,
          dataSourceId: this.dataSourceId,
        }),
      );
      const jobId = response.ingestionJob?.ingestionJobId;
      if (!jobId) {
        throw new Error("StartIngestionJob returned no job id");
      }
      return { started: true, jobId };
    } catch (err) {
      if (err instanceof Error && err.name === "ConflictException") {
        return { started: false };
      }
      throw err;
    }
  }

  async getIngestionJob(jobId: string): Promise<IngestionJob> {
    const response = await this.client.send(
      new GetIngestionJobCommand({
        knowledgeBaseId: this.knowledgeBaseId,
        dataSourceId: this.dataSourceId,
        ingestionJobId: jobId,
      }),
    );
    const job = response.ingestionJob;
    if (!job?.status) {
      throw new Error(`Ingestion job ${jobId} not found`);
    }
    return {
      status: job.status as IngestionJobStatus,
      documentsFailed: job.statistics?.numberOfDocumentsFailed ?? 0,
      failureReasons: job.failureReasons ?? [],
    };
  }
}
