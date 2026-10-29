import type { FastifyRequest } from "fastify";
import type { AccessTokenVerifier } from "../auth/access-tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook on protected routes: the id of the user in the verified access token. */
    userId: string;
  }
}

/** The request has no valid access token. The message is the same whatever was wrong, so it tells an attacker nothing. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Invalid or missing access token");
  }
}

// the scheme is case-insensitive, and there must be exactly one token
const BEARER = /^bearer\s+(\S+)$/i;

/**
 * Requires "Authorization: Bearer <access token>" and puts the user id from the verified token on the request.
 * Nothing else identifies a caller, so a user id in a path, body or header is never believed.
 * Checking a token needs only the key and the clock, so this makes no database read.
 */
export function authHook(tokens: AccessTokenVerifier) {
  return async (request: FastifyRequest): Promise<void> => {
    const match = BEARER.exec(request.headers.authorization ?? "");
    if (!match) {
      throw new UnauthorizedError();
    }
    try {
      request.userId = (await tokens.verify(match[1])).userId;
    } catch {
      throw new UnauthorizedError();
    }
  };
}
