import type { FastifyInstance } from "fastify";
import { MAX_STUDY_PREFERENCES_CHARS, type UsersService } from "../services/users.service.js";
import { toUserResponse } from "./mappers.js";

export interface ProfileRoutesOptions {
  usersService: UsersService;
}

/** The signed-in user's own profile. */
export async function profileRoutes(app: FastifyInstance, opts: ProfileRoutesOptions): Promise<void> {
  const { usersService } = opts;

  app.get("/users/me", async (request) => {
    return toUserResponse(await usersService.getUser(request.userId));
  });

  app.patch<{ Body: { studyPreferences: string | null } }>(
    "/users/me",
    {
      schema: {
        body: {
          type: "object",
          required: ["studyPreferences"],
          additionalProperties: false,
          properties: {
            // a union of a string and null, written as anyOf so the schema compiler has nothing to warn about
            studyPreferences: {
              anyOf: [{ type: "string", maxLength: MAX_STUDY_PREFERENCES_CHARS }, { type: "null" }],
            },
          },
        },
      },
    },
    async (request) => {
      const { studyPreferences } = request.body;
      return toUserResponse(await usersService.updateProfile(request.userId, { studyPreferences }));
    },
  );
}
