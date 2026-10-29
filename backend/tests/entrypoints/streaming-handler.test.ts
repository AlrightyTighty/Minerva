import { Readable, Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createStreamingHandler } from "../../src/entrypoints/streaming-handler.js";

// API Gateway sends REST API proxy events. These tests run the real Fastify app, and replace only the Lambda
// runtime: the writable the response goes to, and the helper that writes the status and headers in front of it.

class FakeResponseStream extends Writable {
  chunks: string[] = [];
  ended = false;

  constructor() {
    super({
      write: (chunk, _encoding, callback) => {
        this.chunks.push(chunk.toString());
        callback();
      },
      final: (callback) => {
        this.ended = true;
        callback();
      },
    });
  }

  get body() {
    return this.chunks.join("");
  }

  async waitUntil(condition: () => boolean) {
    for (let i = 0; i < 200 && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function setup(configure: (app: FastifyInstance) => void) {
  const app = Fastify();
  configure(app);
  let metadata: { statusCode?: number; headers?: Record<string, string> } | undefined;
  const awsLambda = {
    HttpResponseStream: {
      from: (stream: Writable, meta: typeof metadata) => {
        metadata = meta;
        return stream;
      },
    },
  };
  const handler = createStreamingHandler(app, awsLambda as never);
  const run = async (event: unknown) => {
    const stream = new FakeResponseStream();
    await handler(event as never, stream as never, {} as never);
    return { stream, metadata: metadata! };
  };
  return { handler, run, getMetadata: () => metadata };
}

const event = (overrides: Record<string, unknown> = {}) => ({
  httpMethod: "GET",
  path: "/health",
  headers: {},
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  body: null,
  isBase64Encoded: false,
  requestContext: { stage: "prod", path: "/prod/health" },
  ...overrides,
});

const echoApp = (app: FastifyInstance) => {
  app.get("/health", async () => ({ status: "ok" }));
  app.post("/echo", async (request) => ({
    method: request.method,
    url: request.url,
    query: request.query,
    body: request.body,
    userId: request.headers["x-user-id"],
  }));
};

describe("createStreamingHandler", () => {
  it("sends the status and headers ahead of the body, and the body after them", async () => {
    const { run } = setup(echoApp);

    const { stream, metadata } = await run(event());

    expect(metadata.statusCode).toBe(200);
    expect(metadata.headers).toMatchObject({ "content-type": expect.stringContaining("application/json") });
    expect(JSON.parse(stream.body)).toEqual({ status: "ok" });
    expect(stream.ended).toBe(true);
  });

  it("passes the method, path, query string, headers and JSON body to the app", async () => {
    const { run } = setup(echoApp);

    const { stream } = await run(
      event({
        httpMethod: "POST",
        path: "/echo",
        headers: { "x-user-id": "u1", "content-type": "application/json" },
        multiValueQueryStringParameters: { limit: ["10"], tag: ["a", "b"] },
        body: JSON.stringify({ text: "hi" }),
      }),
    );

    const echoed = JSON.parse(stream.body);
    expect(echoed.method).toBe("POST");
    expect(echoed.userId).toBe("u1");
    expect(echoed.body).toEqual({ text: "hi" });
    expect(echoed.query).toEqual({ limit: "10", tag: ["a", "b"] });
  });

  it("encodes query values, which API Gateway hands over decoded", async () => {
    const { run } = setup(echoApp);

    const { stream } = await run(
      event({
        httpMethod: "POST",
        path: "/echo",
        headers: { "content-type": "application/json" },
        multiValueQueryStringParameters: { q: ["a b&c=d"] },
        body: "{}",
      }),
    );

    expect(JSON.parse(stream.body).query).toEqual({ q: "a b&c=d" });
  });

  it("routes on the path without the stage", async () => {
    const { run } = setup(echoApp);

    const { metadata } = await run(event({ path: "/health", requestContext: { stage: "prod", path: "/prod/health" } }));

    expect(metadata.statusCode).toBe(200);
  });

  it("decodes a base64 body", async () => {
    const { run } = setup(echoApp);

    const { stream } = await run(
      event({
        httpMethod: "POST",
        path: "/echo",
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ text: "encoded" })).toString("base64"),
        isBase64Encoded: true,
      }),
    );

    expect(JSON.parse(stream.body).body).toEqual({ text: "encoded" });
  });

  it("returns errors from the app with their own status", async () => {
    const { run } = setup(echoApp);

    const { stream, metadata } = await run(event({ path: "/nowhere" }));

    expect(metadata.statusCode).toBe(404);
    expect(JSON.parse(stream.body)).toMatchObject({ statusCode: 404 });
  });

  it("joins a header that has several values into one", async () => {
    const { run } = setup((app) => {
      app.get("/health", async (_request, reply) => reply.header("x-multi", ["a", "b"]).send({ ok: true }));
    });

    const { metadata } = await run(event());

    expect(metadata.headers?.["x-multi"]).toBe("a, b");
  });

  describe("streaming", () => {
    const sseApp = (gate: Promise<void>) => (app: FastifyInstance) => {
      app.get("/sse", async (_request, reply) => {
        async function* events() {
          yield "event: tool_status\ndata: {}\n\n";
          await gate;
          yield "event: done\ndata: {}\n\n";
        }
        return reply.type("text/event-stream").send(Readable.from(events()));
      });
    };

    it("passes each chunk on as soon as the app produces it, not when the response is complete", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { handler } = setup(sseApp(gate));
      const stream = new FakeResponseStream();

      const finished = handler(event({ path: "/sse" }) as never, stream as never, {} as never);
      await stream.waitUntil(() => stream.chunks.length >= 1);

      // the app is still waiting on the gate, so the reply is not over, yet the first event has already arrived
      expect(stream.body).toBe("event: tool_status\ndata: {}\n\n");
      expect(stream.ended).toBe(false);

      release();
      await finished;

      expect(stream.body).toBe("event: tool_status\ndata: {}\n\nevent: done\ndata: {}\n\n");
      expect(stream.ended).toBe(true);
    });

    it("sends the event-stream content type with the status, before any of the body", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { handler, getMetadata } = setup(sseApp(gate));
      const stream = new FakeResponseStream();

      const finished = handler(event({ path: "/sse" }) as never, stream as never, {} as never);
      await stream.waitUntil(() => stream.chunks.length >= 1);

      expect(getMetadata()?.statusCode).toBe(200);
      expect(getMetadata()?.headers?.["content-type"]).toMatch(/^text\/event-stream/);

      release();
      await finished;
    });
  });
});
