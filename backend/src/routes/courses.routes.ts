import type { FastifyInstance } from "fastify";
import type { CoursesService } from "../services/courses.service.js";
import { toCourseResponse } from "./mappers.js";

export interface CoursesRoutesOptions {
  coursesService: CoursesService;
}

export async function coursesRoutes(app: FastifyInstance, opts: CoursesRoutesOptions): Promise<void> {
  const { coursesService } = opts;

  app.post<{ Body: { name: string } }>(
    "/courses",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const course = await coursesService.createCourse(request.userId, { name: request.body.name });
      return reply.status(201).send(toCourseResponse(course));
    },
  );

  app.get("/courses", async (request) => {
    const courses = await coursesService.listCourses(request.userId);
    return { courses: courses.map(toCourseResponse) };
  });
}
