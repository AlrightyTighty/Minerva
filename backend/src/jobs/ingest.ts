import type { SQSEvent } from "aws-lambda";

// TODO(step 6): StartIngestionJob, then update file status.
export const handler = async (_event: SQSEvent): Promise<void> => {
  throw new Error("ingest is not implemented yet");
};
