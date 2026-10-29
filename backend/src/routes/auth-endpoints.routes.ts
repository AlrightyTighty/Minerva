import type { FastifyInstance } from "fastify";
import {
  PASSWORD_MAX_CHARS,
  type AuthService,
  type RegisterInput,
} from "../services/auth.service.js";
import { toUserResponse } from "./mappers.js";

export interface AuthRoutesOptions {
  authService: AuthService;
}

const EMAIL = { type: "string", minLength: 1, maxLength: 254 };
const NAME = { type: "string", minLength: 1, maxLength: 100 };
// the length rules for a new password are the service's. This only stops absurdly long ones, which are costly to hash.
const PASSWORD = { type: "string", maxLength: PASSWORD_MAX_CHARS };
const REFRESH_TOKEN = { type: "string", minLength: 1, maxLength: 1024 };

/** The endpoints that sign someone in. They are open because they are how a person gets a token. */
export async function publicAuthRoutes(app: FastifyInstance, opts: AuthRoutesOptions): Promise<void> {
  const { authService } = opts;

  app.post<{ Body: RegisterInput }>(
    "/auth/register",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password", "firstName", "lastName"],
          additionalProperties: false,
          properties: { email: EMAIL, password: PASSWORD, firstName: NAME, lastName: NAME },
        },
      },
    },
    async (request, reply) => {
      const { user, tokens } = await authService.register(request.body);
      return reply.status(201).send({ user: toUserResponse(user), ...tokens });
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    "/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          additionalProperties: false,
          properties: { email: EMAIL, password: PASSWORD },
        },
      },
    },
    async (request) => {
      const { user, tokens } = await authService.login(request.body);
      return { user: toUserResponse(user), ...tokens };
    },
  );

  app.post<{ Body: { refreshToken: string } }>(
    "/auth/refresh",
    {
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          additionalProperties: false,
          properties: { refreshToken: REFRESH_TOKEN },
        },
      },
    },
    async (request) => authService.refresh(request.body.refreshToken),
  );

  app.post<{ Body: { refreshToken: string } }>(
    "/auth/logout",
    {
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          additionalProperties: false,
          properties: { refreshToken: REFRESH_TOKEN },
        },
      },
    },
    async (request, reply) => {
      await authService.logout(request.body.refreshToken);
      return reply.status(204).send();
    },
  );
}

/** Changing a password needs a signed-in user. */
export async function protectedAuthRoutes(app: FastifyInstance, opts: AuthRoutesOptions): Promise<void> {
  const { authService } = opts;

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    "/auth/change-password",
    {
      schema: {
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          additionalProperties: false,
          properties: { currentPassword: PASSWORD, newPassword: PASSWORD },
        },
      },
    },
    async (request) => authService.changePassword(request.userId, request.body),
  );
}
