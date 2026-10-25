import type { S3Event } from "aws-lambda";

// TODO(step 5): dedupe by content_hash, then InvokeDataAutomationAsync.
export const handler = async (_event: S3Event): Promise<void> => {
  throw new Error("start-parse is not implemented yet");
};
