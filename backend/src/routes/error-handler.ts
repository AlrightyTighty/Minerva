import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AssignmentNotFoundError, InvalidAssignmentError } from "../services/assignments.service.js";
import { InvalidMessageError } from "../services/chat.service.js";
import { CourseMatchUnavailableError } from "../services/course-match.service.js";
import { CourseNotFoundError } from "../services/courses.service.js";
import { FileNotFoundError, InvalidUploadError } from "../services/files.service.js";
import { InvalidThreadError, ThreadNotFoundError } from "../services/threads.service.js";
import {
  AccountLockedError,
  EmailTakenError,
  IncorrectPasswordError,
  InvalidAuthRequestError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
} from "../services/auth.service.js";
import { InvalidProfileError } from "../services/users.service.js";
import { InvalidWorkPlanError, WorkPlanNotFoundError, WorkPlanUnavailableError } from "../services/work-plans.service.js";
import { UnauthorizedError } from "./auth.js";

/** Maps domain errors to HTTP responses, so routes never need their own try/catch. */
export function apiErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof UnauthorizedError) {
    // the standard asks a 401 to say which scheme to use
    return reply.status(401).header("www-authenticate", "Bearer").send({ message: error.message });
  }
  // wrong credentials, and a refresh token that cannot be used, are 401 for sign-in. These come only from the open
  // /auth endpoints, so a client that gets one knows to send the person back to the sign-in screen.
  if (error instanceof InvalidCredentialsError || error instanceof InvalidRefreshTokenError) {
    return reply.status(401).send({ message: error.message });
  }
  if (error instanceof IncorrectPasswordError) {
    // not 401, which a client would take for an expired session and try to refresh
    return reply.status(403).send({ message: error.message });
  }
  if (error instanceof EmailTakenError) {
    return reply.status(409).send({ message: error.message });
  }
  if (error instanceof AccountLockedError) {
    return reply
      .status(429)
      .header("retry-after", String(error.retryAfterSeconds))
      .send({ message: error.message, retryAfterSeconds: error.retryAfterSeconds });
  }
  if (
    error instanceof CourseNotFoundError ||
    error instanceof FileNotFoundError ||
    error instanceof ThreadNotFoundError ||
    error instanceof AssignmentNotFoundError ||
    error instanceof WorkPlanNotFoundError
  ) {
    return reply.status(404).send({ message: error.message });
  }
  if (
    error instanceof InvalidUploadError ||
    error instanceof InvalidThreadError ||
    error instanceof InvalidMessageError ||
    error instanceof InvalidAssignmentError ||
    error instanceof InvalidProfileError ||
    error instanceof InvalidWorkPlanError ||
    error instanceof InvalidAuthRequestError
  ) {
    return reply.status(400).send({ message: error.message });
  }
  if (error instanceof CourseMatchUnavailableError || error instanceof WorkPlanUnavailableError) {
    return reply.status(502).send({ message: error.message });
  }
  // request validation and other client errors already carry a 4xx status
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    return reply.status(error.statusCode).send({ message: error.message });
  }
  request.log.error(error);
  return reply.status(500).send({ message: "Internal server error" });
}
