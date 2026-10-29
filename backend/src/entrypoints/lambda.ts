import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SecretsManagerSigningKey } from "../auth/signing-key.js";
import { buildApp } from "../app.js";
import { config } from "../config/index.js";
import { createStreamingHandler } from "./streaming-handler.js";

const secretArn = config.auth.jwtKeySecretArn;
if (!secretArn) {
  throw new Error("JWT_KEY_SECRET_ARN is not set");
}

// The signing key is read from Secrets Manager once, when the Lambda starts, and the app is built with it. Nothing is
// served until that has happened, and if it fails every request fails with it, so the API never runs with the wrong key.
const ready = (async () => {
  const signingKey = await new SecretsManagerSigningKey(
    new SecretsManagerClient({ region: config.aws.region }),
    secretArn,
  ).load();
  return createStreamingHandler(buildApp(config, signingKey), awslambda);
})();
ready.catch((error) => console.error(JSON.stringify({ job: "startup", error: error instanceof Error ? error.message : String(error) })));

// API Gateway invokes this through its response-streaming integration, so chat replies reach the client as they are produced
export const handler = awslambda.streamifyResponse(async (event, responseStream, context) => {
  const handle = await ready;
  return handle(event, responseStream, context);
});
