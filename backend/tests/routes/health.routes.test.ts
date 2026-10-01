import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { localConfig } from "../../src/config/environments/local.js";

describe("GET /health", () => {
  it("returns ok status", async () => {
    const app = buildApp(localConfig);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
