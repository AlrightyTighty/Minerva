import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/types.js";
import { createDynamoClient } from "./repositories/dynamo-client.js";
import { ItemsRepository } from "./repositories/items.repository.js";
import { ItemsService } from "./services/items.service.js";
import { healthRoutes } from "./routes/health.routes.js";
import { itemsRoutes } from "./routes/items.routes.js";

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  const dynamoClient = createDynamoClient(config);
  const itemsRepository = new ItemsRepository(dynamoClient, config.dynamodb.tableName);
  const itemsService = new ItemsService(itemsRepository);

  app.register(healthRoutes);
  app.register(itemsRoutes, { itemsService });

  return app;
}
