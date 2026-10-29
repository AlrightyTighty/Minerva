import { describe, expect, it, vi } from "vitest";
import type { BedrockDataAutomationRuntimeClient } from "@aws-sdk/client-bedrock-data-automation-runtime";
import { BdaDocumentParser } from "../../src/clients/document-parser.js";

function build(response: object = { invocationArn: "arn:invocation/1" }) {
  const send = vi.fn().mockResolvedValue(response);
  const parser = new BdaDocumentParser(
    { send } as unknown as BedrockDataAutomationRuntimeClient,
    "arn:project",
    "arn:profile",
  );
  return { parser, send };
}

const input = {
  inputUri: "s3://raw/raw/u1/c1/f1/original.pdf",
  outputUri: "s3://out/bda-output/u1/c1/f1/",
  clientToken: "f1-abc",
};

describe("BdaDocumentParser", () => {
  it("starts the job against our project and profile with the given locations and token", async () => {
    const { parser, send } = build();

    await expect(parser.start(input)).resolves.toBe("arn:invocation/1");

    expect(send.mock.calls[0][0].input).toMatchObject({
      inputConfiguration: { s3Uri: input.inputUri },
      outputConfiguration: { s3Uri: input.outputUri },
      dataAutomationConfiguration: { dataAutomationProjectArn: "arn:project" },
      dataAutomationProfileArn: "arn:profile",
      clientToken: "f1-abc",
    });
  });

  // BDA only publishes its completion events to EventBridge when the caller opts in per job.
  // Without this nothing ever tells post-process that a job finished.
  it("opts in to EventBridge completion events", async () => {
    const { parser, send } = build();

    await parser.start(input);

    expect(send.mock.calls[0][0].input.notificationConfiguration).toEqual({
      eventBridgeConfiguration: { eventBridgeEnabled: true },
    });
  });

  it("fails when BDA returns no invocation ARN", async () => {
    const { parser } = build({});
    await expect(parser.start(input)).rejects.toThrow("invocation ARN");
  });
});
