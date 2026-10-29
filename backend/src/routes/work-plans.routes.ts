import type { FastifyInstance } from "fastify";
import {
  MAX_ASSIGNMENTS_PER_PLAN,
  MAX_WORK_PREFERENCES_CHARS,
  type GenerateWorkPlanInput,
  type WorkPlansService,
} from "../services/work-plans.service.js";
import { toWorkPlanResponse } from "./mappers.js";

export interface WorkPlansRoutesOptions {
  workPlansService: WorkPlansService;
}

export async function workPlansRoutes(app: FastifyInstance, opts: WorkPlansRoutesOptions): Promise<void> {
  const { workPlansService } = opts;

  app.post<{ Body: GenerateWorkPlanInput }>(
    "/work-plans",
    {
      schema: {
        body: {
          type: "object",
          required: ["assignmentIds", "endAt", "timeZone"],
          additionalProperties: false,
          properties: {
            assignmentIds: {
              type: "array",
              minItems: 1,
              maxItems: MAX_ASSIGNMENTS_PER_PLAN,
              items: { type: "string", minLength: 1 },
            },
            endAt: { type: "string", minLength: 1 },
            timeZone: { type: "string", minLength: 1 },
            startAt: { type: "string", minLength: 1 },
            workPreferences: {
              anyOf: [{ type: "string", maxLength: MAX_WORK_PREFERENCES_CHARS }, { type: "null" }],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const plan = await workPlansService.generate(request.userId, request.body);
      return reply.status(201).send(toWorkPlanResponse(plan));
    },
  );

  app.get("/work-plans", async (request) => {
    const plans = await workPlansService.listWorkPlans(request.userId);
    return { workPlans: plans.map(toWorkPlanResponse) };
  });

  app.get("/work-plans/current", async (request) => {
    return toWorkPlanResponse(await workPlansService.getCurrentWorkPlan(request.userId));
  });

  app.get<{ Params: { workPlanId: string } }>("/work-plans/:workPlanId", async (request) => {
    return toWorkPlanResponse(await workPlansService.getWorkPlan(request.userId, request.params.workPlanId));
  });

  app.patch<{ Params: { workPlanId: string; itemId: string }; Body: { completed: boolean } }>(
    "/work-plans/:workPlanId/items/:itemId",
    {
      schema: {
        body: {
          type: "object",
          required: ["completed"],
          additionalProperties: false,
          properties: { completed: { type: "boolean" } },
        },
      },
    },
    async (request) => {
      const { workPlanId, itemId } = request.params;
      const plan = await workPlansService.setItemCompleted(request.userId, workPlanId, itemId, request.body.completed);
      return toWorkPlanResponse(plan);
    },
  );

  app.delete<{ Params: { workPlanId: string } }>("/work-plans/:workPlanId", async (request, reply) => {
    await workPlansService.deleteWorkPlan(request.userId, request.params.workPlanId);
    return reply.status(204).send();
  });
}
