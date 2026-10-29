import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import type { APIGatewayProxyEvent, Context } from "aws-lambda";
import type { FastifyInstance } from "fastify";

/** The part of the Lambda Node.js runtime's `awslambda` global that this handler uses. */
export interface AwsLambdaRuntime {
  HttpResponseStream: {
    /** Writes the status code and headers in front of the body, and returns the stream to write the body to. */
    from(stream: Writable, metadata: { statusCode?: number; headers?: Record<string, string> }): Writable;
  };
}

// set by the transport, so they cannot be passed through as the app produced them
const TRANSPORT_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);

function buildUrl(event: APIGatewayProxyEvent): string {
  const query = new URLSearchParams();
  const multi = event.multiValueQueryStringParameters;
  if (multi) {
    for (const [key, values] of Object.entries(multi)) {
      for (const value of values ?? []) query.append(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
      if (value !== undefined) query.append(key, value);
    }
  }
  const search = query.toString();
  return search ? `${event.path}?${search}` : event.path;
}

function flattenHeaders(headers: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || TRANSPORT_HEADERS.has(name.toLowerCase())) continue;
    flat[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return flat;
}

/**
 * Runs the Fastify app for an API Gateway REST API proxy event and streams its response back, so a reply
 * reaches the client chunk by chunk (server-sent events) instead of after the whole thing is built.
 * Wrap the result in `awslambda.streamifyResponse`. @fastify/aws-lambda buffers, so it cannot be used for this.
 */
export function createStreamingHandler(app: FastifyInstance, runtime: AwsLambdaRuntime) {
  return async (event: APIGatewayProxyEvent, responseStream: Writable, _context: Context): Promise<void> => {
    const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body) : undefined;

    // resolves once the app starts responding, with the rest of the body still to come
    const response = await app.inject({
      method: event.httpMethod as never,
      url: buildUrl(event),
      headers: event.headers ?? {},
      payload: body,
      payloadAsStream: true,
    });

    const out = runtime.HttpResponseStream.from(responseStream, {
      statusCode: response.statusCode,
      headers: flattenHeaders(response.headers),
    });
    await pipeline(response.stream(), out);
  };
}
