import type { FastifyInstance } from "fastify";
import type { AccessTokenVerifier } from "../auth/access-tokens.js";
import type { AssignmentsService } from "../services/assignments.service.js";
import type { AuthService } from "../services/auth.service.js";
import type { ChatService } from "../services/chat.service.js";
import type { CourseMatchService } from "../services/course-match.service.js";
import type { CoursesService } from "../services/courses.service.js";
import type { FilesService } from "../services/files.service.js";
import type { ThreadsService } from "../services/threads.service.js";
import type { UsersService } from "../services/users.service.js";
import type { WorkPlansService } from "../services/work-plans.service.js";
import { assignmentsRoutes } from "./assignments.routes.js";
import { authHook } from "./auth.js";
import { protectedAuthRoutes, publicAuthRoutes } from "./auth-endpoints.routes.js";
import { courseMatchRoutes } from "./course-match.routes.js";
import { coursesRoutes } from "./courses.routes.js";
import { apiErrorHandler } from "./error-handler.js";
import { filesRoutes } from "./files.routes.js";
import { healthRoutes } from "./health.routes.js";
import { profileRoutes } from "./profile.routes.js";
import { threadsRoutes } from "./threads.routes.js";
import { validatorCompiler } from "./validation.js";
import { workPlansRoutes } from "./work-plans.routes.js";

export interface ApiServices {
  /** Checks access tokens. */
  tokens: AccessTokenVerifier;
  auth: AuthService;
  users: UsersService;
  courses: CoursesService;
  files: FilesService;
  assignments: AssignmentsService;
  courseMatch: CourseMatchService;
  workPlans: WorkPlansService;
  threads: ThreadsService;
  chat: ChatService;
}

/**
 * Registers every API route. Only /health and the /auth endpoints that sign someone in are open. Everything else
 * sits behind the auth hook, which requires a valid access token.
 */
export function registerApiRoutes(app: FastifyInstance, services: ApiServices): void {
  app.setErrorHandler(apiErrorHandler);
  app.setValidatorCompiler(validatorCompiler);

  app.register(healthRoutes);
  app.register(publicAuthRoutes, { authService: services.auth });

  app.register(async (protectedApp) => {
    protectedApp.decorateRequest("userId", "");
    protectedApp.addHook("onRequest", authHook(services.tokens));

    protectedApp.register(protectedAuthRoutes, { authService: services.auth });
    protectedApp.register(profileRoutes, { usersService: services.users });
    protectedApp.register(coursesRoutes, { coursesService: services.courses });
    protectedApp.register(filesRoutes, { filesService: services.files });
    protectedApp.register(assignmentsRoutes, { assignmentsService: services.assignments });
    protectedApp.register(courseMatchRoutes, { courseMatchService: services.courseMatch });
    protectedApp.register(workPlansRoutes, { workPlansService: services.workPlans });
    protectedApp.register(threadsRoutes, { threadsService: services.threads, chatService: services.chat });
  });
}
