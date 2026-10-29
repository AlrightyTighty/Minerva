import type { FastifyInstance } from "fastify";
import type { CourseMatchService } from "../services/course-match.service.js";

export interface CourseMatchRoutesOptions {
  courseMatchService: CourseMatchService;
}

const MAX_NAMES = 50;
const MAX_NAME_CHARS = 200;

export async function courseMatchRoutes(app: FastifyInstance, opts: CourseMatchRoutesOptions): Promise<void> {
  const { courseMatchService } = opts;

  app.post<{ Body: { courseNames: string[] } }>(
    "/courses/match",
    {
      schema: {
        body: {
          type: "object",
          required: ["courseNames"],
          additionalProperties: false,
          properties: {
            courseNames: {
              type: "array",
              minItems: 1,
              maxItems: MAX_NAMES,
              items: { type: "string", minLength: 1, maxLength: MAX_NAME_CHARS },
            },
          },
        },
      },
    },
    async (request) => {
      const matches = await courseMatchService.matchCourses(request.userId, request.body.courseNames);
      return { matches };
    },
  );
}
