import awsLambdaFastify from "@fastify/aws-lambda";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { buildApp } from "../app.js";
import { config } from "../config/index.js";

const app = buildApp(config);
const proxy = awsLambdaFastify(app);

export const handler = (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => proxy(event, context);
