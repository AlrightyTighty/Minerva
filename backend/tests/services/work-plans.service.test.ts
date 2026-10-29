import { describe, expect, it, vi } from "vitest";
import type { Assignment, WorkPlan, WorkPlanItem } from "../../src/models/items.js";
import { AssignmentNotFoundError } from "../../src/services/assignments.service.js";
import {
  InvalidWorkPlanError,
  MAX_ASSIGNMENTS_PER_PLAN,
  MAX_PLAN_DAYS,
  MAX_WORK_PREFERENCES_CHARS,
  WorkPlanNotFoundError,
  WorkPlansService,
  WorkPlanUnavailableError,
} from "../../src/services/work-plans.service.js";

const NOW = new Date("2026-10-28T14:00:00.000Z");
const START = "2026-10-28T14:00:00.000Z";
const END = "2026-11-01T14:00:00.000Z";

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({
  assignmentId: "a1",
  courseId: "c1",
  userId: "u1",
  title: "Lab 2",
  description: "Greedy lab",
  dueAt: "2026-10-31T22:00:00.000Z",
  fileIds: [],
  completedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const draftItem = (overrides: Record<string, unknown> = {}) => ({
  kind: "work",
  name: "Lab 2",
  description: "Do the lab",
  startAt: "2026-10-29T15:00:00.000Z",
  endAt: "2026-10-29T17:00:00.000Z",
  assignmentId: "a1",
  ...overrides,
});

const request = (overrides: Record<string, unknown> = {}) => ({
  assignmentIds: ["a1"],
  endAt: END,
  timeZone: "America/Chicago",
  ...overrides,
});

let nextItem = 0;
function build(options: { assignments?: Assignment[]; draft?: unknown[]; studyPreferences?: string | null } = {}) {
  nextItem = 0;
  const workPlans = {
    create: vi.fn().mockResolvedValue(true),
    get: vi.fn(),
    listByUser: vi.fn().mockResolvedValue([]),
    setItemsCompleted: vi.fn().mockResolvedValue(true),
    softDelete: vi.fn().mockResolvedValue(true),
  };
  const assignments = {
    listAllAssignments: vi.fn().mockResolvedValue(options.assignments ?? [assignment()]),
    setCompletionFromPlan: vi.fn().mockResolvedValue(undefined),
  };
  const users = { getUser: vi.fn().mockResolvedValue({ userId: "u1", studyPreferences: options.studyPreferences ?? null }) };
  const planner = { plan: vi.fn().mockResolvedValue(options.draft ?? [draftItem()]) };
  const ids = ["w-new"];
  const service = new WorkPlansService({
    workPlans,
    assignments,
    users,
    planner,
    newId: () => ids.shift() ?? `i-${++nextItem}`,
    now: () => NOW,
  } as never);
  return { service, workPlans, assignments, users, planner };
}

describe("WorkPlansService.generate: what it asks the planner", () => {
  it("passes the chosen assignments, the window, the time zone, the current time and both kinds of preferences", async () => {
    const { service, planner } = build({ studyPreferences: "Short sessions." });

    await service.generate("u1", request({ workPreferences: "Nothing after 9pm." }));

    expect(planner.plan).toHaveBeenCalledWith({
      now: START,
      startAt: START,
      endAt: END,
      timeZone: "America/Chicago",
      studyPreferences: "Short sessions.",
      workPreferences: "Nothing after 9pm.",
      assignments: [{ assignmentId: "a1", title: "Lab 2", description: "Greedy lab", dueAt: "2026-10-31T22:00:00.000Z" }],
    });
  });

  it("starts the plan now unless told otherwise", async () => {
    const { service, planner } = build();

    const plan = await service.generate("u1", request());

    expect(planner.plan.mock.calls[0][0].startAt).toBe(START);
    expect(plan.startAt).toBe(START);
  });

  it("uses the start the student gave, as UTC", async () => {
    const { service, planner } = build({ draft: [draftItem({ startAt: "2026-10-30T15:00:00.000Z", endAt: "2026-10-30T17:00:00.000Z" })] });

    const plan = await service.generate("u1", request({ startAt: "2026-10-30T09:00:00-05:00" }));

    expect(planner.plan.mock.calls[0][0].startAt).toBe("2026-10-30T14:00:00.000Z");
    expect(plan.startAt).toBe("2026-10-30T14:00:00.000Z");
  });

  it("sends null for preferences the student has not set", async () => {
    const { service, planner } = build();

    await service.generate("u1", request());

    expect(planner.plan.mock.calls[0][0].studyPreferences).toBeNull();
    expect(planner.plan.mock.calls[0][0].workPreferences).toBeNull();
  });

  it("trims the work preferences, and treats blank as none", async () => {
    const { service, planner } = build();

    await service.generate("u1", request({ workPreferences: "  Mornings only.  " }));
    await service.generate("u1", request({ workPreferences: "   " }));

    expect(planner.plan.mock.calls[0][0].workPreferences).toBe("Mornings only.");
    expect(planner.plan.mock.calls[1][0].workPreferences).toBeNull();
  });

  it("reads the study preferences of the signed-in user", async () => {
    const { service, users } = build();

    await service.generate("u1", request());

    expect(users.getUser).toHaveBeenCalledWith("u1");
  });
});

describe("WorkPlansService.generate: refusing the request", () => {
  const refuses = async (input: Record<string, unknown>, setup?: (b: ReturnType<typeof build>) => void) => {
    const b = build();
    setup?.(b);
    await expect(b.service.generate("u1", input as never)).rejects.toThrow(InvalidWorkPlanError);
    expect(b.planner.plan).not.toHaveBeenCalled();
    expect(b.workPlans.create).not.toHaveBeenCalled();
  };

  it("allows up to 500 characters of work preferences", () => {
    expect(MAX_WORK_PREFERENCES_CHARS).toBe(500);
  });

  it.each([
    ["no assignments", { assignmentIds: [] }],
    ["an end that is not a date", { endAt: "friday" }],
    ["a start that is not a date", { startAt: "now" }],
    ["an end that is not after the start", { startAt: "2026-11-01T14:00:00.000Z", endAt: "2026-11-01T14:00:00.000Z" }],
    ["an end that is before the start", { startAt: "2026-11-02T14:00:00.000Z" }],
    ["an end that is already past", { startAt: "2026-10-20T00:00:00.000Z", endAt: "2026-10-21T00:00:00.000Z" }],
    ["a time zone that does not exist", { timeZone: "Mars/Olympus_Mons" }],
    ["a blank time zone", { timeZone: "  " }],
    ["work preferences over 500 characters", { workPreferences: "x".repeat(501) }],
  ])("rejects %s without calling the model", async (_label, overrides) => {
    await refuses(request(overrides));
  });

  it("rejects a plan longer than the maximum", async () => {
    const long = new Date(NOW.getTime() + (MAX_PLAN_DAYS * 24 + 1) * 3600_000).toISOString();
    await refuses(request({ endAt: long }));
  });

  it("accepts a plan of exactly the maximum length", async () => {
    const edge = new Date(NOW.getTime() + MAX_PLAN_DAYS * 24 * 3600_000).toISOString();
    const { service } = build({ draft: [draftItem()] });

    await expect(service.generate("u1", request({ endAt: edge }))).resolves.toBeDefined();
  });

  it("counts work preference characters as a person does, so 500 emoji are fine", async () => {
    const { service } = build();

    await expect(service.generate("u1", request({ workPreferences: "😀".repeat(500) }))).resolves.toBeDefined();
  });

  it("accepts a time zone it recognises, in any case it is written", async () => {
    const { service } = build();

    await expect(service.generate("u1", request({ timeZone: "Europe/Paris" }))).resolves.toBeDefined();
    await expect(service.generate("u1", request({ timeZone: "UTC" }))).resolves.toBeDefined();
  });

  it(`rejects more than ${MAX_ASSIGNMENTS_PER_PLAN} assignments`, async () => {
    await refuses(request({ assignmentIds: Array.from({ length: MAX_ASSIGNMENTS_PER_PLAN + 1 }, (_, i) => `a${i}`) }));
  });

  it("rejects an assignment that is not the user's, does not exist, or is deleted, naming it", async () => {
    const { service, planner } = build({ assignments: [assignment()] });

    await expect(service.generate("u1", request({ assignmentIds: ["a1", "a9"] }))).rejects.toThrow(/a9/);
    await expect(service.generate("u1", request({ assignmentIds: ["a9"] }))).rejects.toThrow(InvalidWorkPlanError);

    expect(planner.plan).not.toHaveBeenCalled();
  });

  it("rejects an assignment that is already completed, naming it", async () => {
    const { service, planner } = build({ assignments: [assignment({ completedAt: "2026-10-27T00:00:00.000Z" })] });

    await expect(service.generate("u1", request())).rejects.toThrow(/a1/);

    expect(planner.plan).not.toHaveBeenCalled();
  });

  it("plans an assignment once, however many times it is listed", async () => {
    const { service, planner } = build();

    await service.generate("u1", request({ assignmentIds: ["a1", "a1"] }));

    expect(planner.plan.mock.calls[0][0].assignments).toHaveLength(1);
  });

  it("allows assignments from different courses in one plan", async () => {
    const { service } = build({
      assignments: [assignment(), assignment({ assignmentId: "a2", courseId: "c2" })],
      draft: [draftItem(), draftItem({ assignmentId: "a2", startAt: "2026-10-29T18:00:00.000Z", endAt: "2026-10-29T19:00:00.000Z" })],
    });

    const plan = await service.generate("u1", request({ assignmentIds: ["a1", "a2"] }));

    expect(plan.items.map((i) => i.assignment)).toEqual([
      { courseId: "c1", assignmentId: "a1" },
      { courseId: "c2", assignmentId: "a2" },
    ]);
  });
});

describe("WorkPlansService.generate: the plan that is stored", () => {
  it("stores the plan for the user, with the window, time zone, preferences and the current time", async () => {
    const { service, workPlans } = build();

    const plan = await service.generate("u1", request({ workPreferences: "Mornings only." }));

    expect(workPlans.create).toHaveBeenCalledWith(plan);
    expect(plan).toMatchObject({
      workPlanId: "w-new",
      userId: "u1",
      startAt: START,
      endAt: END,
      timeZone: "America/Chicago",
      workPreferences: "Mornings only.",
      createdAt: START,
    });
  });

  it("gives every item an id, an assignment reference with its course, and no completion", async () => {
    const { service } = build({
      draft: [
        draftItem(),
        draftItem({ kind: "break", name: "Break", assignmentId: null, startAt: "2026-10-29T17:00:00.000Z", endAt: "2026-10-29T17:30:00.000Z" }),
      ],
    });

    const plan = await service.generate("u1", request());

    expect(plan.items[0]).toEqual({
      itemId: expect.any(String),
      kind: "work",
      name: "Lab 2",
      description: "Do the lab",
      startAt: "2026-10-29T15:00:00.000Z",
      endAt: "2026-10-29T17:00:00.000Z",
      assignment: { courseId: "c1", assignmentId: "a1" },
      completedAt: null,
    });
    expect(plan.items[1]).toMatchObject({ kind: "break", assignment: null, completedAt: null });
    expect(new Set(plan.items.map((i) => i.itemId)).size).toBe(2);
  });

  it("stores times as UTC, whatever offset the model wrote them in", async () => {
    const { service } = build({
      draft: [draftItem({ startAt: "2026-10-29T10:00:00-05:00", endAt: "2026-10-29T12:00:00-05:00" })],
    });

    const plan = await service.generate("u1", request());

    expect(plan.items[0].startAt).toBe("2026-10-29T15:00:00.000Z");
    expect(plan.items[0].endAt).toBe("2026-10-29T17:00:00.000Z");
  });

  it("keeps the items in time order, whatever order the model listed them in", async () => {
    const { service } = build({
      draft: [
        draftItem({ name: "Later", startAt: "2026-10-30T15:00:00.000Z", endAt: "2026-10-30T16:00:00.000Z" }),
        draftItem({ name: "Earlier", startAt: "2026-10-29T15:00:00.000Z", endAt: "2026-10-29T16:00:00.000Z" }),
      ],
    });

    const plan = await service.generate("u1", request());

    expect(plan.items.map((i) => i.name)).toEqual(["Earlier", "Later"]);
  });

  it("trims names and descriptions", async () => {
    const { service } = build({ draft: [draftItem({ name: "  Lab 2  ", description: "  Do it \n" })] });

    const plan = await service.generate("u1", request());

    expect(plan.items[0]).toMatchObject({ name: "Lab 2", description: "Do it" });
  });

  it("allows a work item that is not about an assignment, such as reviewing notes", async () => {
    const { service } = build({
      draft: [draftItem(), draftItem({ name: "Review notes", assignmentId: null, startAt: "2026-10-29T18:00:00.000Z", endAt: "2026-10-29T19:00:00.000Z" })],
    });

    const plan = await service.generate("u1", request());

    expect(plan.items[1]).toMatchObject({ kind: "work", assignment: null });
  });

  it("allows an assignment to be split into several parts", async () => {
    const { service } = build({
      draft: [
        draftItem({ name: "Lab 2 (1/2)" }),
        draftItem({ name: "Lab 2 (2/2)", startAt: "2026-10-30T15:00:00.000Z", endAt: "2026-10-30T17:00:00.000Z" }),
      ],
    });

    const plan = await service.generate("u1", request());

    expect(plan.items.filter((i) => i.assignment?.assignmentId === "a1")).toHaveLength(2);
  });
});

describe("WorkPlansService.generate: checking what the model made", () => {
  const rejected = async (draft: unknown[], options: { assignments?: Assignment[]; input?: Record<string, unknown> } = {}) => {
    const b = build({ draft, assignments: options.assignments });
    // every attempt gets the same bad plan, so the service gives up
    await expect(b.service.generate("u1", request(options.input))).rejects.toThrow(WorkPlanUnavailableError);
    expect(b.workPlans.create).not.toHaveBeenCalled();
    return b;
  };

  it.each([
    ["nothing", []],
    ["an item with an unknown kind", [draftItem({ kind: "nap" })]],
    ["an item with a blank name", [draftItem({ name: "  " })]],
    ["a time that is not a date", [draftItem({ startAt: "tomorrow" })]],
    ["an item that ends before it starts", [draftItem({ startAt: "2026-10-29T17:00:00.000Z", endAt: "2026-10-29T15:00:00.000Z" })]],
    ["an item that has no length", [draftItem({ startAt: "2026-10-29T15:00:00.000Z", endAt: "2026-10-29T15:00:00.000Z" })]],
    ["an item before the plan starts", [draftItem({ startAt: "2026-10-28T10:00:00.000Z", endAt: "2026-10-28T11:00:00.000Z" })]],
    ["an item after the plan ends", [draftItem({ startAt: "2026-11-01T13:00:00.000Z", endAt: "2026-11-01T15:00:00.000Z" })]],
    ["an assignment the student did not choose", [draftItem({ assignmentId: "a-made-up" })]],
    ["a break that belongs to an assignment", [draftItem(), draftItem({ kind: "break", startAt: "2026-10-29T18:00:00.000Z", endAt: "2026-10-29T18:30:00.000Z" })]],
    ["items that overlap", [draftItem(), draftItem({ name: "Overlap", startAt: "2026-10-29T16:00:00.000Z", endAt: "2026-10-29T18:00:00.000Z" })]],
    ["no work for a chosen assignment", [draftItem({ kind: "break", assignmentId: null })]],
  ])("rejects a plan with %s, and stores nothing", async (_label, draft) => {
    await rejected(draft);
  });

  it("rejects work that finishes after the assignment is due", async () => {
    await rejected([draftItem({ startAt: "2026-10-31T21:00:00.000Z", endAt: "2026-10-31T23:00:00.000Z" })]);
  });

  it("accepts work that finishes exactly when the assignment is due", async () => {
    const { service } = build({ draft: [draftItem({ startAt: "2026-10-31T21:00:00.000Z", endAt: "2026-10-31T22:00:00.000Z" })] });

    await expect(service.generate("u1", request())).resolves.toBeDefined();
  });

  it("accepts items that touch, such as work followed directly by a break", async () => {
    const { service } = build({
      draft: [draftItem(), draftItem({ kind: "break", name: "Break", assignmentId: null, startAt: "2026-10-29T17:00:00.000Z", endAt: "2026-10-29T17:30:00.000Z" })],
    });

    await expect(service.generate("u1", request())).resolves.toBeDefined();
  });

  it("does not hold an assignment that was already overdue when the plan starts to a deadline it cannot meet", async () => {
    const overdue = assignment({ dueAt: "2026-10-27T22:00:00.000Z" });
    const { service } = build({ assignments: [overdue], draft: [draftItem()] });

    await expect(service.generate("u1", request())).resolves.toBeDefined();
  });

  it("does not hold an assignment due after the window to the window's end as well as its own deadline", async () => {
    const later = assignment({ dueAt: "2026-11-20T00:00:00.000Z" });
    const { service } = build({ assignments: [later], draft: [draftItem()] });

    await expect(service.generate("u1", request())).resolves.toBeDefined();
  });

  it("asks once more when the first plan is invalid, telling the model what was wrong, and stores the second", async () => {
    const { service, planner, workPlans } = build();
    planner.plan.mockResolvedValueOnce([draftItem({ kind: "nap" })]).mockResolvedValueOnce([draftItem()]);

    const plan = await service.generate("u1", request());

    expect(planner.plan).toHaveBeenCalledTimes(2);
    expect(planner.plan.mock.calls[0][0].problems).toBeUndefined();
    expect(planner.plan.mock.calls[1][0].problems?.length).toBeGreaterThan(0);
    expect(workPlans.create).toHaveBeenCalledTimes(1);
    expect(plan.items).toHaveLength(1);
  });

  it("asks once more when the model call fails, and stores the second", async () => {
    const { service, planner } = build();
    planner.plan.mockRejectedValueOnce(new Error("throttled")).mockResolvedValueOnce([draftItem()]);

    await expect(service.generate("u1", request())).resolves.toBeDefined();

    expect(planner.plan).toHaveBeenCalledTimes(2);
  });

  it("gives up after two attempts, and reports the AI as unavailable without leaking the reason", async () => {
    const { service, planner, workPlans } = build();
    planner.plan.mockRejectedValue(new Error("ThrottlingException: secret internals"));

    const attempt = service.generate("u1", request());

    await expect(attempt).rejects.toThrow(WorkPlanUnavailableError);
    await expect(attempt).rejects.not.toThrow(/secret internals/);
    expect(planner.plan).toHaveBeenCalledTimes(2);
    expect(workPlans.create).not.toHaveBeenCalled();
  });
});

const item = (overrides: Partial<WorkPlanItem> = {}): WorkPlanItem => ({
  itemId: "i1",
  kind: "work",
  name: "Lab 2",
  description: "",
  startAt: "2026-10-29T15:00:00.000Z",
  endAt: "2026-10-29T17:00:00.000Z",
  assignment: { courseId: "c1", assignmentId: "a1" },
  completedAt: null,
  ...overrides,
});

const plan = (items: WorkPlanItem[], overrides: Partial<WorkPlan> = {}): WorkPlan => ({
  workPlanId: "w1",
  userId: "u1",
  startAt: START,
  endAt: END,
  timeZone: "America/Chicago",
  workPreferences: null,
  items,
  createdAt: START,
  ...overrides,
});

describe("WorkPlansService reading", () => {
  it("returns a plan", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(plan([item()]));

    await expect(service.getWorkPlan("u1", "w1")).resolves.toEqual(plan([item()]));
    expect(workPlans.get).toHaveBeenCalledWith("u1", "w1");
  });

  it("throws WorkPlanNotFoundError for a missing plan, which also covers another user's", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(undefined);

    await expect(service.getWorkPlan("u1", "w9")).rejects.toThrow(WorkPlanNotFoundError);
  });

  it("treats a soft-deleted plan as not found", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(plan([item()], { deletedAt: "2026-10-29T00:00:00.000Z" }));

    await expect(service.getWorkPlan("u1", "w1")).rejects.toThrow(WorkPlanNotFoundError);
  });

  it("lists the user's plans that are not deleted, newest first", async () => {
    const { service, workPlans } = build();
    workPlans.listByUser.mockResolvedValue([
      plan([], { workPlanId: "w1" }),
      plan([], { workPlanId: "w3" }),
      plan([], { workPlanId: "w2", deletedAt: "2026-10-29T00:00:00.000Z" }),
    ]);

    const result = await service.listWorkPlans("u1");

    expect(result.map((p) => p.workPlanId)).toEqual(["w3", "w1"]);
  });

  it("returns the newest plan that is not deleted as the current one", async () => {
    const { service, workPlans } = build();
    workPlans.listByUser.mockResolvedValue([
      plan([], { workPlanId: "w1" }),
      plan([], { workPlanId: "w2" }),
      plan([], { workPlanId: "w3", deletedAt: "2026-10-29T00:00:00.000Z" }),
    ]);

    await expect(service.getCurrentWorkPlan("u1")).resolves.toMatchObject({ workPlanId: "w2" });
  });

  it("throws WorkPlanNotFoundError when there is no current plan", async () => {
    const { service } = build();

    await expect(service.getCurrentWorkPlan("u1")).rejects.toThrow(WorkPlanNotFoundError);
  });
});

describe("WorkPlansService.deleteWorkPlan", () => {
  it("soft-deletes the plan now, and leaves the assignments alone", async () => {
    const { service, workPlans, assignments } = build();
    workPlans.get.mockResolvedValue(plan([item()]));

    await service.deleteWorkPlan("u1", "w1");

    expect(workPlans.softDelete).toHaveBeenCalledWith("u1", "w1", START);
    expect(assignments.setCompletionFromPlan).not.toHaveBeenCalled();
  });

  it("throws WorkPlanNotFoundError for one that does not exist or is already deleted, keeping the first deletion time", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(plan([], { deletedAt: "2026-10-29T00:00:00.000Z" }));

    await expect(service.deleteWorkPlan("u1", "w1")).rejects.toThrow(WorkPlanNotFoundError);

    expect(workPlans.softDelete).not.toHaveBeenCalled();
  });
});

describe("WorkPlansService.setItemCompleted", () => {
  const complete = (service: WorkPlansService, itemId = "i1", completed = true) =>
    service.setItemCompleted("u1", "w1", itemId, completed);

  it("marks an item completed now, and returns the plan with it completed", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(plan([item({ itemId: "i1", assignment: null }), item({ itemId: "i2", assignment: null })]));

    const result = await complete(service, "i2");

    expect(workPlans.setItemsCompleted).toHaveBeenCalledWith("u1", "w1", [{ index: 1, itemId: "i2", completedAt: START }]);
    expect(result.items.map((i) => i.completedAt)).toEqual([null, START]);
  });

  it("marks an item open again", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(plan([item({ completedAt: "2026-10-29T17:00:00.000Z", assignment: null })]));

    const result = await complete(service, "i1", false);

    expect(workPlans.setItemsCompleted).toHaveBeenCalledWith("u1", "w1", [{ index: 0, itemId: "i1", completedAt: null }]);
    expect(result.items[0].completedAt).toBeNull();
  });

  it.each([
    ["completing an item that is already complete, which keeps its first time", true, "2026-10-29T17:00:00.000Z"],
    ["reopening an item that is already open", false, null],
  ])("writes nothing for %s", async (_label, completed, current) => {
    const { service, workPlans, assignments } = build();
    workPlans.get.mockResolvedValue(plan([item({ completedAt: current })]));

    const result = await complete(service, "i1", completed);

    expect(workPlans.setItemsCompleted).not.toHaveBeenCalled();
    expect(assignments.setCompletionFromPlan).not.toHaveBeenCalled();
    expect(result.items[0].completedAt).toBe(current);
  });

  it("throws WorkPlanNotFoundError for an item that is not in the plan, and writes nothing", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(plan([item()]));

    await expect(complete(service, "nope")).rejects.toThrow(WorkPlanNotFoundError);

    expect(workPlans.setItemsCompleted).not.toHaveBeenCalled();
  });

  it("throws WorkPlanNotFoundError for a plan that does not exist or is deleted", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(plan([item()], { deletedAt: "2026-10-29T00:00:00.000Z" }));

    await expect(complete(service)).rejects.toThrow(WorkPlanNotFoundError);
  });

  it("refuses to complete a break, since there is nothing to finish", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(plan([item({ kind: "break", assignment: null })]));

    await expect(complete(service)).rejects.toThrow(InvalidWorkPlanError);

    expect(workPlans.setItemsCompleted).not.toHaveBeenCalled();
  });

  it("throws WorkPlanNotFoundError when the plan changed under it between the read and the write", async () => {
    const { service, workPlans } = build();
    workPlans.get.mockResolvedValue(plan([item()]));
    workPlans.setItemsCompleted.mockResolvedValue(false);

    await expect(complete(service)).rejects.toThrow(WorkPlanNotFoundError);
  });

  describe("completing the assignment", () => {
    it("completes the assignment when its only item is done", async () => {
      const { service, workPlans, assignments } = build();
      workPlans.get.mockResolvedValue(plan([item()]));

      await complete(service);

      expect(assignments.setCompletionFromPlan).toHaveBeenCalledWith("u1", "c1", "a1", true);
    });

    it("completes the assignment only when the last of its parts is done", async () => {
      const { service, workPlans, assignments } = build();
      workPlans.get.mockResolvedValue(
        plan([item({ itemId: "i1", completedAt: "2026-10-29T17:00:00.000Z" }), item({ itemId: "i2" }), item({ itemId: "i3" })]),
      );

      await complete(service, "i2");
      expect(assignments.setCompletionFromPlan).not.toHaveBeenCalled();

      workPlans.get.mockResolvedValue(
        plan([
          item({ itemId: "i1", completedAt: "2026-10-29T17:00:00.000Z" }),
          item({ itemId: "i2", completedAt: "2026-10-29T18:00:00.000Z" }),
          item({ itemId: "i3" }),
        ]),
      );
      await complete(service, "i3");

      expect(assignments.setCompletionFromPlan).toHaveBeenCalledTimes(1);
      expect(assignments.setCompletionFromPlan).toHaveBeenCalledWith("u1", "c1", "a1", true);
    });

    it("looks only at the parts of the same assignment, and ignores breaks and other assignments", async () => {
      const { service, workPlans, assignments } = build();
      workPlans.get.mockResolvedValue(
        plan([
          item({ itemId: "i1" }),
          item({ itemId: "b1", kind: "break", assignment: null }),
          item({ itemId: "o1", assignment: { courseId: "c2", assignmentId: "a2" } }),
          item({ itemId: "n1", assignment: null }),
        ]),
      );

      await complete(service, "i1");

      expect(assignments.setCompletionFromPlan).toHaveBeenCalledWith("u1", "c1", "a1", true);
    });

    it("does not touch an assignment when completing an item that has none", async () => {
      const { service, workPlans, assignments } = build();
      workPlans.get.mockResolvedValue(plan([item({ assignment: null })]));

      await complete(service);

      expect(assignments.setCompletionFromPlan).not.toHaveBeenCalled();
    });

    it("reopens the assignment when a part is un-completed", async () => {
      const { service, workPlans, assignments } = build();
      workPlans.get.mockResolvedValue(
        plan([item({ itemId: "i1", completedAt: "t" }), item({ itemId: "i2", completedAt: "t" })]),
      );

      await complete(service, "i2", false);

      expect(assignments.setCompletionFromPlan).toHaveBeenCalledWith("u1", "c1", "a1", false);
    });

    it("carries on, with the item saved, when the assignment has since been deleted", async () => {
      const { service, workPlans, assignments } = build();
      workPlans.get.mockResolvedValue(plan([item()]));
      assignments.setCompletionFromPlan.mockRejectedValue(new AssignmentNotFoundError("a1"));

      const result = await complete(service);

      expect(result.items[0].completedAt).toBe(START);
      expect(workPlans.setItemsCompleted).toHaveBeenCalled();
    });

    it("lets any other failure through, so it is not silently lost", async () => {
      const { service, workPlans, assignments } = build();
      workPlans.get.mockResolvedValue(plan([item()]));
      assignments.setCompletionFromPlan.mockRejectedValue(new Error("dynamo down"));

      await expect(complete(service)).rejects.toThrow("dynamo down");
    });

    it("saves the item before it changes the assignment, so a failure never leaves the assignment ahead of the plan", async () => {
      const { service, workPlans, assignments } = build();
      workPlans.get.mockResolvedValue(plan([item()]));
      const order: string[] = [];
      workPlans.setItemsCompleted.mockImplementation(async () => {
        order.push("plan");
        return true;
      });
      assignments.setCompletionFromPlan.mockImplementation(async () => {
        order.push("assignment");
      });

      await complete(service);

      expect(order).toEqual(["plan", "assignment"]);
    });
  });
});
