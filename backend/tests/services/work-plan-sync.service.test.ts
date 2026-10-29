import { describe, expect, it, vi } from "vitest";
import type { WorkPlan, WorkPlanItem } from "../../src/models/items.js";
import { WorkPlanSyncService } from "../../src/services/work-plan-sync.service.js";

const ref = { courseId: "c1", assignmentId: "a1" };
const DONE = "2026-10-30T12:00:00.000Z";

const item = (itemId: string, overrides: Partial<WorkPlanItem> = {}): WorkPlanItem => ({
  itemId,
  kind: "work",
  name: itemId,
  description: "",
  startAt: "2026-10-29T15:00:00.000Z",
  endAt: "2026-10-29T17:00:00.000Z",
  assignment: ref,
  completedAt: null,
  ...overrides,
});

const plan = (workPlanId: string, items: WorkPlanItem[], overrides: Partial<WorkPlan> = {}): WorkPlan => ({
  workPlanId,
  userId: "u1",
  startAt: "2026-10-28T14:00:00.000Z",
  endAt: "2026-11-01T14:00:00.000Z",
  timeZone: "UTC",
  workPreferences: null,
  items,
  createdAt: "2026-10-28T14:00:00.000Z",
  ...overrides,
});

function build(plans: WorkPlan[] = []) {
  const workPlans = {
    listByUser: vi.fn().mockResolvedValue(plans),
    setItemsCompleted: vi.fn().mockResolvedValue(true),
  };
  return { sync: new WorkPlanSyncService({ workPlans } as never), workPlans };
}

// When an assignment is completed or reopened outside a work plan, the plans must agree, or they show stale to-dos.
describe("WorkPlanSyncService.syncAssignment", () => {
  it("marks every unfinished part of the assignment completed when the assignment is completed", async () => {
    const { sync, workPlans } = build([plan("w1", [item("i1"), item("i2", { completedAt: "2026-10-29T17:00:00.000Z" }), item("i3")])]);

    await sync.syncAssignment("u1", ref, DONE);

    expect(workPlans.setItemsCompleted).toHaveBeenCalledWith("u1", "w1", [
      { index: 0, itemId: "i1", completedAt: DONE },
      { index: 2, itemId: "i3", completedAt: DONE },
    ]);
  });

  it("keeps the completion time of a part that was already done", async () => {
    const { sync, workPlans } = build([plan("w1", [item("i1", { completedAt: "2026-10-29T17:00:00.000Z" })])]);

    await sync.syncAssignment("u1", ref, DONE);

    expect(workPlans.setItemsCompleted).not.toHaveBeenCalled();
  });

  it("marks every part of the assignment open again when the assignment is reopened", async () => {
    const { sync, workPlans } = build([
      plan("w1", [item("i1", { completedAt: DONE }), item("i2"), item("i3", { completedAt: DONE })]),
    ]);

    await sync.syncAssignment("u1", ref, null);

    expect(workPlans.setItemsCompleted).toHaveBeenCalledWith("u1", "w1", [
      { index: 0, itemId: "i1", completedAt: null },
      { index: 2, itemId: "i3", completedAt: null },
    ]);
  });

  it("reaches the assignment's parts in every plan the user has", async () => {
    const { sync, workPlans } = build([plan("w1", [item("i1")]), plan("w2", [item("j1")])]);

    await sync.syncAssignment("u1", ref, DONE);

    expect(workPlans.setItemsCompleted).toHaveBeenCalledTimes(2);
    expect(workPlans.setItemsCompleted.mock.calls.map((c) => c[1])).toEqual(["w1", "w2"]);
  });

  it("leaves other assignments, breaks, and items with no assignment alone", async () => {
    const { sync, workPlans } = build([
      plan("w1", [
        item("i1"),
        item("o1", { assignment: { courseId: "c1", assignmentId: "a2" } }),
        item("o2", { assignment: { courseId: "c2", assignmentId: "a1" } }), // same assignment id, different course
        item("b1", { kind: "break", assignment: null }),
        item("n1", { assignment: null }),
      ]),
    ]);

    await sync.syncAssignment("u1", ref, DONE);

    expect(workPlans.setItemsCompleted).toHaveBeenCalledWith("u1", "w1", [{ index: 0, itemId: "i1", completedAt: DONE }]);
  });

  it("skips plans that are deleted, and plans with nothing to change", async () => {
    const { sync, workPlans } = build([
      plan("w1", [item("i1")], { deletedAt: "2026-10-29T00:00:00.000Z" }),
      plan("w2", [item("x", { assignment: { courseId: "c1", assignmentId: "a9" } })]),
    ]);

    await sync.syncAssignment("u1", ref, DONE);

    expect(workPlans.setItemsCompleted).not.toHaveBeenCalled();
  });

  it("only ever looks at the given user's plans", async () => {
    const { sync, workPlans } = build();

    await sync.syncAssignment("u1", ref, DONE);

    expect(workPlans.listByUser).toHaveBeenCalledWith("u1");
  });

  it("still updates the other plans when one of them changed under it and could not be written", async () => {
    const { sync, workPlans } = build([plan("w1", [item("i1")]), plan("w2", [item("j1")])]);
    workPlans.setItemsCompleted.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(sync.syncAssignment("u1", ref, DONE)).resolves.toBeUndefined();

    expect(workPlans.setItemsCompleted).toHaveBeenCalledTimes(2);
  });
});
