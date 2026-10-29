export function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}
