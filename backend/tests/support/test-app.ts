import Fastify, { type FastifyInstance } from "fastify";
import { vi } from "vitest";
import { InvalidTokenError } from "../../src/auth/access-tokens.js";
import { registerApiRoutes, type ApiServices } from "../../src/routes/index.js";

export const USER = {
  userId: "u1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  studyPreferences: null,
  createdAt: "2026-10-26T00:00:00.000Z",
};

export type MockedServices = {
  [K in keyof ApiServices]: { [M in keyof ApiServices[K]]: ReturnType<typeof vi.fn> };
};

/** The one access token these tests treat as valid. It belongs to USER. */
export const VALID_TOKEN = "valid-access-token-for-u1";

/**
 * A Fastify app with the real routes, auth hook and error handling, over mocked services. Real token checking is
 * tested on its own, so here `tokens.verify` accepts VALID_TOKEN as USER and refuses anything else.
 */
export function buildTestApp(): { app: FastifyInstance; services: MockedServices } {
  const services: MockedServices = {
    tokens: {
      verify: vi.fn(async (token: string) => {
        if (token !== VALID_TOKEN) {
          throw new InvalidTokenError();
        }
        return { userId: USER.userId };
      }),
    },
    auth: {
      register: vi.fn(),
      login: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
    },
    users: {
      updateProfile: vi.fn(),
      getUser: vi.fn(async () => USER),
    },
    courses: {
      createCourse: vi.fn(),
      listCourses: vi.fn(),
      getCourse: vi.fn(),
    },
    files: {
      createUpload: vi.fn(),
      listFiles: vi.fn(),
      getFile: vi.fn(),
      getDownloadUrl: vi.fn(),
    },
    assignments: {
      createAssignment: vi.fn(),
      listAssignments: vi.fn(),
      listAllAssignments: vi.fn(),
      getAssignment: vi.fn(),
      updateAssignment: vi.fn(),
      deleteAssignment: vi.fn(),
      createFileUpload: vi.fn(),
    },
    courseMatch: {
      matchCourses: vi.fn(),
    },
    workPlans: {
      generate: vi.fn(),
      listWorkPlans: vi.fn(),
      getCurrentWorkPlan: vi.fn(),
      getWorkPlan: vi.fn(),
      setItemCompleted: vi.fn(),
      deleteWorkPlan: vi.fn(),
    },
    threads: {
      createThread: vi.fn(),
      listThreads: vi.fn(),
      getThread: vi.fn(),
      listMessages: vi.fn(),
    },
    chat: {
      sendMessage: vi.fn(),
    },
  };

  const app = Fastify();
  registerApiRoutes(app, services as unknown as ApiServices);
  return { app, services };
}

/** The header a signed-in client sends. */
export const AUTH = { authorization: `Bearer ${VALID_TOKEN}` };
