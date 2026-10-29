import type { WorkPlansRepository } from "../repositories/work-plans.repository.js";

export interface PlanSync {
  /** Makes every plan agree with the assignment: its parts all completed at that time, or all open (null). */
  syncAssignment(
    userId: string,
    assignment: { courseId: string; assignmentId: string },
    completedAt: string | null,
  ): Promise<void>;
}

export interface WorkPlanSyncDeps {
  workPlans: Pick<WorkPlansRepository, "listByUser" | "setItemsCompleted">;
}

/**
 * When an assignment is completed or reopened outside a work plan, the plans still list its parts. This brings
 * them in line, so a plan never shows a to-do for an assignment that is already done (or the other way round).
 */
export class WorkPlanSyncService implements PlanSync {
  constructor(private readonly deps: WorkPlanSyncDeps) {}

  async syncAssignment(
    userId: string,
    assignment: { courseId: string; assignmentId: string },
    completedAt: string | null,
  ): Promise<void> {
    const plans = await this.deps.workPlans.listByUser(userId);

    for (const plan of plans) {
      if (plan.deletedAt) continue;

      const changes = plan.items.flatMap((item, index) => {
        const isPart =
          item.kind === "work" &&
          item.assignment?.courseId === assignment.courseId &&
          item.assignment.assignmentId === assignment.assignmentId;
        if (!isPart) return [];
        // a part that is already done keeps the time it was finished, and an open one stays open
        const needsChange = completedAt === null ? item.completedAt !== null : item.completedAt === null;
        return needsChange ? [{ index, itemId: item.itemId, completedAt }] : [];
      });

      if (changes.length === 0) continue;
      // a plan that changed under us is skipped: the rest should still be brought in line
      await this.deps.workPlans.setItemsCompleted(userId, plan.workPlanId, changes);
    }
  }
}
