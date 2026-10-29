import type { DraftItem, WorkPlanner } from "../clients/work-planner.js";
import type { Assignment, WorkPlan, WorkPlanItem } from "../models/items.js";
import type { WorkPlansRepository } from "../repositories/work-plans.repository.js";
import { AssignmentNotFoundError, type AssignmentsService } from "./assignments.service.js";
import type { UsersService } from "./users.service.js";

export class WorkPlanNotFoundError extends Error {
  constructor(id: string) {
    super(`Work plan "${id}" not found`);
  }
}

/** The request cannot be made into a plan as it is. */
export class InvalidWorkPlanError extends Error {}

/** The AI could not produce a valid plan, even after a second try. */
export class WorkPlanUnavailableError extends Error {
  constructor() {
    super("A work plan could not be made right now. Please try again.");
  }
}

export const MAX_WORK_PREFERENCES_CHARS = 500;
export const MAX_ASSIGNMENTS_PER_PLAN = 20;
export const MAX_PLAN_DAYS = 31;

/** The model gets one second chance, told what was wrong with its first plan. */
const MAX_ATTEMPTS = 2;

export interface GenerateWorkPlanInput {
  assignmentIds: string[];
  endAt: string;
  timeZone: string;
  startAt?: string;
  workPreferences?: string | null;
}

export interface WorkPlansServiceDeps {
  workPlans: WorkPlansRepository;
  assignments: Pick<AssignmentsService, "listAllAssignments" | "setCompletionFromPlan">;
  users: Pick<UsersService, "getUser">;
  planner: WorkPlanner;
  newId: () => string;
  now: () => Date;
}

const byId = (a: WorkPlan, b: WorkPlan) => (a.workPlanId < b.workPlanId ? 1 : a.workPlanId > b.workPlanId ? -1 : 0);

function parseTime(value: string, field: string): number {
  const time = Date.parse(value);
  if (typeof value !== "string" || Number.isNaN(time)) {
    throw new InvalidWorkPlanError(`${field} must be a valid ISO 8601 date or date-time`);
  }
  return time;
}

function isTimeZone(name: string): boolean {
  if (typeof name !== "string" || name.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Trims the text, and treats blank as none. The limit counts characters as a person does, not UTF-16 units. */
function normalizeWorkPreferences(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return null;
  if (Array.from(trimmed).length > MAX_WORK_PREFERENCES_CHARS) {
    throw new InvalidWorkPlanError(`workPreferences must be at most ${MAX_WORK_PREFERENCES_CHARS} characters`);
  }
  return trimmed;
}

interface Window {
  startAt: number;
  endAt: number;
}

/** What is wrong with a plan the model made, in words it can act on. Empty when it is fine. */
function findProblems(draft: DraftItem[], assignments: Assignment[], window: Window): string[] {
  const problems: string[] = [];
  if (draft.length === 0) {
    return ["The plan has no items."];
  }

  const byAssignment = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]));
  const worked = new Set<string>();
  const blocks: { number: number; start: number; end: number }[] = [];

  draft.forEach((item, index) => {
    const label = `Item ${index + 1} ("${item.name}")`;
    if (item.kind !== "work" && item.kind !== "break") {
      problems.push(`${label} has an unknown kind.`);
    }
    if (item.name.trim() === "") {
      problems.push(`${label} has no name.`);
    }

    const start = Date.parse(item.startAt);
    const end = Date.parse(item.endAt);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      problems.push(`${label} has a start or end that is not a valid ISO 8601 time.`);
      return;
    }
    if (end <= start) {
      problems.push(`${label} must end after it starts.`);
    }
    if (start < window.startAt || end > window.endAt) {
      problems.push(`${label} is outside the window ${new Date(window.startAt).toISOString()} to ${new Date(window.endAt).toISOString()}.`);
    }
    blocks.push({ number: index + 1, start, end });

    if (item.kind === "break") {
      if (item.assignmentId !== null) {
        problems.push(`${label} is a break, so its assignmentId must be null.`);
      }
      return;
    }
    if (item.assignmentId === null) {
      return;
    }
    const assignment = byAssignment.get(item.assignmentId);
    if (!assignment) {
      problems.push(`${label} refers to assignment "${item.assignmentId}", which is not one of the assignments to plan.`);
      return;
    }
    worked.add(item.assignmentId);
    // an assignment that was already overdue when the plan starts cannot meet its due date, so it is waived
    const due = Date.parse(assignment.dueAt);
    if (due >= window.startAt && end > due) {
      problems.push(`${label} ends after assignment "${assignment.title}" is due (${assignment.dueAt}).`);
    }
  });

  const ordered = [...blocks].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) {
      problems.push(`Item ${ordered[i].number} overlaps item ${ordered[i - 1].number}.`);
    }
  }
  for (const assignment of assignments) {
    if (!worked.has(assignment.assignmentId)) {
      problems.push(`Assignment "${assignment.title}" (${assignment.assignmentId}) has no work scheduled.`);
    }
  }
  return problems;
}

export class WorkPlansService {
  constructor(private readonly deps: WorkPlansServiceDeps) {}

  /** Asks the AI for a plan for the chosen assignments, checks it, and stores it. */
  async generate(userId: string, input: GenerateWorkPlanInput): Promise<WorkPlan> {
    const { workPlans, assignments, users, planner, newId, now } = this.deps;

    const nowTime = now().getTime();
    const startAt = input.startAt !== undefined ? parseTime(input.startAt, "startAt") : nowTime;
    const endAt = parseTime(input.endAt, "endAt");
    if (endAt <= startAt) {
      throw new InvalidWorkPlanError("endAt must be after startAt");
    }
    if (endAt <= nowTime) {
      throw new InvalidWorkPlanError("endAt must be in the future");
    }
    if (endAt - startAt > MAX_PLAN_DAYS * 24 * 3600_000) {
      throw new InvalidWorkPlanError(`A work plan can cover at most ${MAX_PLAN_DAYS} days`);
    }
    if (!isTimeZone(input.timeZone)) {
      throw new InvalidWorkPlanError("timeZone must be an IANA time zone such as America/Chicago");
    }
    const timeZone = input.timeZone.trim();
    const workPreferences = normalizeWorkPreferences(input.workPreferences);

    const ids = [...new Set(input.assignmentIds)];
    if (ids.length === 0) {
      throw new InvalidWorkPlanError("Choose at least one assignment");
    }
    if (ids.length > MAX_ASSIGNMENTS_PER_PLAN) {
      throw new InvalidWorkPlanError(`A work plan can cover at most ${MAX_ASSIGNMENTS_PER_PLAN} assignments`);
    }

    // listAllAssignments already leaves deleted assignments out, and only returns the user's own
    const available = new Map((await assignments.listAllAssignments(userId)).map((a) => [a.assignmentId, a]));
    const chosen: Assignment[] = [];
    for (const id of ids) {
      const assignment = available.get(id);
      if (!assignment) {
        throw new InvalidWorkPlanError(`Assignment "${id}" was not found`);
      }
      if (assignment.completedAt) {
        throw new InvalidWorkPlanError(`Assignment "${id}" is already completed`);
      }
      chosen.push(assignment);
    }

    const profile = await users.getUser(userId);
    const base = {
      now: new Date(nowTime).toISOString(),
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
      timeZone,
      studyPreferences: profile.studyPreferences ?? null,
      workPreferences,
      assignments: chosen.map(({ assignmentId, title, description, dueAt }) => ({ assignmentId, title, description, dueAt })),
    };

    const draft = await this.askForValidPlan(base, chosen, { startAt, endAt });

    const workPlanId = newId();
    const courseOf = new Map(chosen.map((a) => [a.assignmentId, a.courseId]));
    const items: WorkPlanItem[] = draft
      .map((item) => ({ item, start: Date.parse(item.startAt) }))
      .sort((a, b) => a.start - b.start)
      .map(({ item, start }) => ({
        itemId: newId(),
        kind: item.kind,
        name: item.name.trim(),
        description: item.description.trim(),
        startAt: new Date(start).toISOString(),
        endAt: new Date(Date.parse(item.endAt)).toISOString(),
        assignment: item.assignmentId ? { courseId: courseOf.get(item.assignmentId) as string, assignmentId: item.assignmentId } : null,
        completedAt: null,
      }));

    const plan: WorkPlan = {
      workPlanId,
      userId,
      startAt: base.startAt,
      endAt: base.endAt,
      timeZone,
      workPreferences,
      items,
      createdAt: new Date(nowTime).toISOString(),
    };
    if (!(await workPlans.create(plan))) {
      throw new Error(`Work plan id collision for ${plan.workPlanId}`);
    }
    return plan;
  }

  /** The plan, once it passes every check. On a bad plan the model is told what was wrong and tries once more. */
  private async askForValidPlan(
    base: Parameters<WorkPlanner["plan"]>[0],
    assignments: Assignment[],
    window: Window,
  ): Promise<DraftItem[]> {
    let problems: string[] | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const draft = await this.deps.planner.plan(problems ? { ...base, problems } : base);
        problems = findProblems(draft, assignments, window);
        if (problems.length === 0) {
          return draft;
        }
      } catch (err) {
        console.error(JSON.stringify({ job: "work-plan", error: err instanceof Error ? err.message : String(err) }));
        problems = undefined;
      }
    }
    throw new WorkPlanUnavailableError();
  }

  /** The user's plans that are not deleted, newest first. */
  async listWorkPlans(userId: string): Promise<WorkPlan[]> {
    const plans = await this.deps.workPlans.listByUser(userId);
    return plans.filter((plan) => !plan.deletedAt).sort(byId);
  }

  async getCurrentWorkPlan(userId: string): Promise<WorkPlan> {
    const [newest] = await this.listWorkPlans(userId);
    if (!newest) {
      throw new WorkPlanNotFoundError("current");
    }
    return newest;
  }

  /** Plans are keyed by user, so another user's plan is simply not found. */
  async getWorkPlan(userId: string, workPlanId: string): Promise<WorkPlan> {
    const plan = await this.deps.workPlans.get(userId, workPlanId);
    if (!plan || plan.deletedAt) {
      throw new WorkPlanNotFoundError(workPlanId);
    }
    return plan;
  }

  /** Soft-deletes the plan. The assignments are left as they are. */
  async deleteWorkPlan(userId: string, workPlanId: string): Promise<void> {
    await this.getWorkPlan(userId, workPlanId);
    const deleted = await this.deps.workPlans.softDelete(userId, workPlanId, this.deps.now().toISOString());
    if (!deleted) {
      throw new WorkPlanNotFoundError(workPlanId);
    }
  }

  /**
   * Marks one item completed or open, and carries it through to the assignment: finishing the last part of an
   * assignment completes it, and reopening any part reopens it.
   */
  async setItemCompleted(userId: string, workPlanId: string, itemId: string, completed: boolean): Promise<WorkPlan> {
    const plan = await this.getWorkPlan(userId, workPlanId);
    const index = plan.items.findIndex((item) => item.itemId === itemId);
    if (index === -1) {
      throw new WorkPlanNotFoundError(itemId);
    }
    const item = plan.items[index];
    if (item.kind === "break") {
      throw new InvalidWorkPlanError("A break cannot be completed");
    }
    if (completed === (item.completedAt !== null)) {
      return plan;
    }

    const completedAt = completed ? this.deps.now().toISOString() : null;
    // saved first, so a failure can never leave the assignment ahead of the plan
    if (!(await this.deps.workPlans.setItemsCompleted(userId, workPlanId, [{ index, itemId, completedAt }]))) {
      throw new WorkPlanNotFoundError(workPlanId);
    }
    const updated: WorkPlan = {
      ...plan,
      items: plan.items.map((existing, i) => (i === index ? { ...existing, completedAt } : existing)),
    };

    if (item.assignment) {
      const { courseId, assignmentId } = item.assignment;
      const parts = updated.items.filter(
        (part) => part.kind === "work" && part.assignment?.courseId === courseId && part.assignment.assignmentId === assignmentId,
      );
      if (!completed || parts.every((part) => part.completedAt !== null)) {
        try {
          await this.deps.assignments.setCompletionFromPlan(userId, courseId, assignmentId, completed);
        } catch (err) {
          // the assignment was deleted since, so there is nothing to complete or reopen
          if (!(err instanceof AssignmentNotFoundError)) throw err;
        }
      }
    }
    return updated;
  }
}
