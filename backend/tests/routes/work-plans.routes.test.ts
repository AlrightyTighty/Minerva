import { describe, expect, it } from "vitest";
import type { WorkPlan } from "../../src/models/items.js";
import {
  InvalidWorkPlanError,
  WorkPlanNotFoundError,
  WorkPlanUnavailableError,
} from "../../src/services/work-plans.service.js";
import { AUTH, buildTestApp } from "../support/test-app.js";

// userId and deletedAt are set, so the tests prove neither reaches the client
const plan: WorkPlan = {
  workPlanId: "w1",
  userId: "u1",
  startAt: "2026-10-28T14:00:00.000Z",
  endAt: "2026-11-01T14:00:00.000Z",
  timeZone: "America/Chicago",
  workPreferences: "Mornings only.",
  items: [
    {
      itemId: "i1",
      kind: "work",
      name: "Lab 2 (part 1 of 2)",
      description: "Read the handout",
      startAt: "2026-10-29T15:00:00.000Z",
      endAt: "2026-10-29T17:00:00.000Z",
      assignment: { courseId: "c1", assignmentId: "a1" },
      completedAt: null,
    },
    {
      itemId: "i2",
      kind: "break",
      name: "Break",
      description: "Stretch",
      startAt: "2026-10-29T17:00:00.000Z",
      endAt: "2026-10-29T17:30:00.000Z",
      assignment: null,
      completedAt: null,
    },
  ],
  createdAt: "2026-10-28T14:00:00.000Z",
  deletedAt: undefined,
};

const planResponse = {
  workPlanId: "w1",
  startAt: "2026-10-28T14:00:00.000Z",
  endAt: "2026-11-01T14:00:00.000Z",
  timeZone: "America/Chicago",
  workPreferences: "Mornings only.",
  items: plan.items,
  createdAt: "2026-10-28T14:00:00.000Z",
};

const body = { assignmentIds: ["a1"], endAt: "2026-11-01T14:00:00.000Z", timeZone: "America/Chicago" };

describe("POST /work-plans", () => {
  const post = (app: ReturnType<typeof buildTestApp>["app"], payload: unknown) =>
    app.inject({ method: "POST", url: "/work-plans", headers: AUTH, payload: payload as object });

  it("makes a plan for the caller and returns it", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.generate.mockResolvedValue(plan);

    const response = await post(app, { ...body, workPreferences: "Mornings only." });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(planResponse);
    expect(services.workPlans.generate).toHaveBeenCalledWith("u1", { ...body, workPreferences: "Mornings only." });
  });

  it("passes an optional start and null work preferences through", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.generate.mockResolvedValue(plan);

    await post(app, { ...body, startAt: "2026-10-30T09:00:00-05:00", workPreferences: null });

    expect(services.workPlans.generate).toHaveBeenCalledWith("u1", {
      ...body,
      startAt: "2026-10-30T09:00:00-05:00",
      workPreferences: null,
    });
  });

  it("needs only the assignments, an end and a time zone", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.generate.mockResolvedValue(plan);

    const response = await post(app, body);

    expect(response.statusCode).toBe(201);
    expect(services.workPlans.generate).toHaveBeenCalledWith("u1", body);
  });

  it("ignores fields it does not know, such as a user id", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.generate.mockResolvedValue(plan);

    await post(app, { ...body, userId: "someone-else", items: [] });

    expect(services.workPlans.generate).toHaveBeenCalledWith("u1", body);
  });

  it("accepts exactly 500 characters of work preferences, counting emoji as one each", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.generate.mockResolvedValue(plan);

    expect((await post(app, { ...body, workPreferences: "😀".repeat(500) })).statusCode).toBe(201);
    expect((await post(app, { ...body, workPreferences: "😀".repeat(501) })).statusCode).toBe(400);
  });

  it.each([
    ["no assignments", { ...body, assignmentIds: undefined }],
    ["an empty list of assignments", { ...body, assignmentIds: [] }],
    ["assignments that are not a list", { ...body, assignmentIds: "a1" }],
    ["an assignment id that is not text", { ...body, assignmentIds: [7] }],
    ["more than 20 assignments", { ...body, assignmentIds: Array.from({ length: 21 }, (_, i) => `a${i}`) }],
    ["no end", { ...body, endAt: undefined }],
    ["an end that is not text", { ...body, endAt: 20261101 }],
    ["no time zone", { ...body, timeZone: undefined }],
    ["an empty time zone", { ...body, timeZone: "" }],
    ["work preferences that are a number", { ...body, workPreferences: 5 }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await post(app, payload);

    expect(response.statusCode).toBe(400);
    expect(services.workPlans.generate).not.toHaveBeenCalled();
  });

  it("returns 400 with the reason when the service refuses the request", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.generate.mockRejectedValue(new InvalidWorkPlanError("Assignment a9 was not found"));

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "Assignment a9 was not found" });
  });

  it("returns 502 with a message the student can be shown when the AI could not make a valid plan", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.generate.mockRejectedValue(new WorkPlanUnavailableError());

    const response = await post(app, body);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ message: "A work plan could not be made right now. Please try again." });
  });
});

describe("GET /work-plans", () => {
  it("lists the caller's plans, newest first", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.listWorkPlans.mockResolvedValue([plan, { ...plan, workPlanId: "w0" }]);

    const response = await app.inject({ method: "GET", url: "/work-plans", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json().workPlans.map((p: any) => p.workPlanId)).toEqual(["w1", "w0"]);
    expect(services.workPlans.listWorkPlans).toHaveBeenCalledWith("u1");
  });

  it("returns an empty list when there are none", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.listWorkPlans.mockResolvedValue([]);

    const response = await app.inject({ method: "GET", url: "/work-plans", headers: AUTH });

    expect(response.json()).toEqual({ workPlans: [] });
  });
});

describe("GET /work-plans/current", () => {
  it("returns the newest plan, without internal fields", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.getCurrentWorkPlan.mockResolvedValue(plan);

    const response = await app.inject({ method: "GET", url: "/work-plans/current", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(planResponse);
    expect(response.json()).not.toHaveProperty("userId");
    expect(response.json()).not.toHaveProperty("deletedAt");
    expect(services.workPlans.getWorkPlan).not.toHaveBeenCalled();
  });

  it("returns 404 when there is no plan yet", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.getCurrentWorkPlan.mockRejectedValue(new WorkPlanNotFoundError("current"));

    const response = await app.inject({ method: "GET", url: "/work-plans/current", headers: AUTH });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /work-plans/:workPlanId", () => {
  it("returns the plan", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.getWorkPlan.mockResolvedValue(plan);

    const response = await app.inject({ method: "GET", url: "/work-plans/w1", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(planResponse);
    expect(services.workPlans.getWorkPlan).toHaveBeenCalledWith("u1", "w1");
  });

  it("returns 404 for a missing plan, or another user's", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.getWorkPlan.mockRejectedValue(new WorkPlanNotFoundError("w9"));

    const response = await app.inject({ method: "GET", url: "/work-plans/w9", headers: AUTH });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: 'Work plan "w9" not found' });
  });
});

describe("PATCH /work-plans/:workPlanId/items/:itemId", () => {
  const patch = (app: ReturnType<typeof buildTestApp>["app"], payload: unknown) =>
    app.inject({ method: "PATCH", url: "/work-plans/w1/items/i1", headers: AUTH, payload: payload as object });

  it("marks an item completed and returns the whole plan", async () => {
    const { app, services } = buildTestApp();
    const done = { ...plan, items: [{ ...plan.items[0], completedAt: "2026-10-29T17:00:00.000Z" }, plan.items[1]] };
    services.workPlans.setItemCompleted.mockResolvedValue(done);

    const response = await patch(app, { completed: true });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].completedAt).toBe("2026-10-29T17:00:00.000Z");
    expect(services.workPlans.setItemCompleted).toHaveBeenCalledWith("u1", "w1", "i1", true);
  });

  it("marks it open again", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.setItemCompleted.mockResolvedValue(plan);

    await patch(app, { completed: false });

    expect(services.workPlans.setItemCompleted).toHaveBeenCalledWith("u1", "w1", "i1", false);
  });

  it.each([
    ["no body fields", {}],
    ["a value that is not a boolean", { completed: "yes" }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await patch(app, payload);

    expect(response.statusCode).toBe(400);
    expect(services.workPlans.setItemCompleted).not.toHaveBeenCalled();
  });

  it("returns 400 for a break, which cannot be completed", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.setItemCompleted.mockRejectedValue(new InvalidWorkPlanError("A break cannot be completed"));

    const response = await patch(app, { completed: true });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "A break cannot be completed" });
  });

  it("returns 404 for a missing plan or item", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.setItemCompleted.mockRejectedValue(new WorkPlanNotFoundError("i1"));

    const response = await patch(app, { completed: true });

    expect(response.statusCode).toBe(404);
  });
});

describe("DELETE /work-plans/:workPlanId", () => {
  it("deletes the plan and returns nothing", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.deleteWorkPlan.mockResolvedValue(undefined);

    const response = await app.inject({ method: "DELETE", url: "/work-plans/w1", headers: AUTH });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(services.workPlans.deleteWorkPlan).toHaveBeenCalledWith("u1", "w1");
  });

  it("returns 404 for a missing or already deleted plan", async () => {
    const { app, services } = buildTestApp();
    services.workPlans.deleteWorkPlan.mockRejectedValue(new WorkPlanNotFoundError("w1"));

    const response = await app.inject({ method: "DELETE", url: "/work-plans/w1", headers: AUTH });

    expect(response.statusCode).toBe(404);
  });
});
