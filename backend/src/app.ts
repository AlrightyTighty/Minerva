import Fastify, { type FastifyInstance } from "fastify";
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "./config/types.js";
import { AccessTokenService } from "./auth/access-tokens.js";
import { ScryptPasswordHasher } from "./auth/password.js";
import { generateEphemeralSigningKey } from "./auth/signing-key.js";
import { CourseTools } from "./chat/tools.js";
import { BedrockChatModel } from "./clients/chat-model.js";
import { BedrockCourseMatcher } from "./clients/course-matcher.js";
import { BedrockCourseSearch } from "./clients/course-search.js";
import { BedrockWorkPlanner } from "./clients/work-planner.js";
import { S3ObjectStore } from "./clients/object-store.js";
import { S3UploadSigner } from "./clients/upload-signer.js";
import { newId } from "./models/ids.js";
import { createDynamoClient } from "./repositories/dynamo-client.js";
import { AssignmentsRepository } from "./repositories/assignments.repository.js";
import { CoursesRepository } from "./repositories/courses.repository.js";
import { FilesRepository } from "./repositories/files.repository.js";
import { LoginsRepository } from "./repositories/logins.repository.js";
import { RefreshTokensRepository } from "./repositories/refresh-tokens.repository.js";
import { MessagesRepository } from "./repositories/messages.repository.js";
import { ThreadsRepository } from "./repositories/threads.repository.js";
import { UsersRepository } from "./repositories/users.repository.js";
import { WorkPlansRepository } from "./repositories/work-plans.repository.js";
import { registerApiRoutes } from "./routes/index.js";
import { AssignmentsService } from "./services/assignments.service.js";
import { AuthService } from "./services/auth.service.js";
import { ChatService } from "./services/chat.service.js";
import { CourseMatchService } from "./services/course-match.service.js";
import { CoursesService } from "./services/courses.service.js";
import { FilesService } from "./services/files.service.js";
import { ThreadsService } from "./services/threads.service.js";
import { UsersService } from "./services/users.service.js";
import { WorkPlanSyncService } from "./services/work-plan-sync.service.js";
import { WorkPlansService } from "./services/work-plans.service.js";

/**
 * `signingKeyPem` is the JWT signing key. Only a local run may leave it out, which makes a throwaway one,
 * so a deployed API can never start with a key nobody chose.
 */
export function buildApp(config: AppConfig, signingKeyPem?: string): FastifyInstance {
  if (!signingKeyPem && config.env !== "local") {
    throw new Error("The JWT signing key is required outside a local run");
  }
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  const dynamoClient = createDynamoClient(config);
  const tableName = config.dynamodb.tableName;
  const now = () => new Date();

  const usersRepository = new UsersRepository(dynamoClient, tableName);
  const accessTokens = new AccessTokenService({
    privateKeyPem: signingKeyPem ?? generateEphemeralSigningKey(),
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    ttlSeconds: config.auth.accessTokenTtlSeconds,
  });
  const auth = new AuthService({
    users: usersRepository,
    logins: new LoginsRepository(dynamoClient, tableName),
    refreshTokens: new RefreshTokensRepository(dynamoClient, tableName),
    hasher: new ScryptPasswordHasher(),
    tokens: accessTokens,
    newId,
    now,
  });
  const users = new UsersService({ users: usersRepository, newId, now });
  const courses = new CoursesService({ courses: new CoursesRepository(dynamoClient, tableName), newId, now });
  const filesRepository = new FilesRepository(dynamoClient, tableName);
  const s3 = new S3Client({ region: config.aws.region });
  const files = new FilesService({
    files: filesRepository,
    courses,
    signer: new S3UploadSigner(s3, config.s3.rawBucket),
    newId,
    now,
  });

  const workPlansRepository = new WorkPlansRepository(dynamoClient, tableName);
  const assignments = new AssignmentsService({
    assignments: new AssignmentsRepository(dynamoClient, tableName),
    courses,
    files,
    planSync: new WorkPlanSyncService({ workPlans: workPlansRepository }),
    newId,
    now,
  });
  const bedrock = new BedrockRuntimeClient({ region: config.aws.region });
  const workPlans = new WorkPlansService({
    workPlans: workPlansRepository,
    assignments,
    users,
    planner: new BedrockWorkPlanner(bedrock, config.bedrock.workPlanModelId),
    newId,
    now,
  });
  const courseMatch = new CourseMatchService({
    courses,
    matcher: new BedrockCourseMatcher(bedrock, config.bedrock.matchModelId),
  });

  const threadsRepository = new ThreadsRepository(dynamoClient, tableName);
  const messagesRepository = new MessagesRepository(dynamoClient, tableName);
  const objects = new S3ObjectStore(s3);
  const threads = new ThreadsService({
    threads: threadsRepository,
    messages: messagesRepository,
    files: filesRepository,
    courses,
    assignments,
    newId,
    now,
  });
  const chat = new ChatService({
    threads: threadsRepository,
    messages: messagesRepository,
    files: filesRepository,
    assignments,
    users,
    objects,
    tools: new CourseTools({
      files: filesRepository,
      search: new BedrockCourseSearch(
        new BedrockAgentRuntimeClient({ region: config.aws.region }),
        config.bedrock.knowledgeBaseId,
      ),
      objects,
      threads: threadsRepository,
      processedBucket: config.s3.processedBucket,
    }),
    model: new BedrockChatModel(bedrock, config.bedrock.chatModelId),
    rawBucket: config.s3.rawBucket,
    processedBucket: config.s3.processedBucket,
    newId,
    now,
  });

  registerApiRoutes(app, { tokens: accessTokens, auth, users, courses, files, assignments, courseMatch, workPlans, threads, chat });

  return app;
}
