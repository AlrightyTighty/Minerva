import type { FastifyInstance } from "fastify";
import { ItemNotFoundError, type ItemsService } from "../services/items.service.js";

export interface ItemsRoutesOptions {
  itemsService: ItemsService;
}

export async function itemsRoutes(app: FastifyInstance, opts: ItemsRoutesOptions): Promise<void> {
  const { itemsService } = opts;

  app.get<{ Params: { id: string } }>("/items/:id", async (request, reply) => {
    try {
      const item = await itemsService.getItem(request.params.id);
      return item;
    } catch (err) {
      if (err instanceof ItemNotFoundError) {
        return reply.status(404).send({ message: err.message });
      }
      throw err;
    }
  });

  app.post<{ Body: { name: string } }>("/items", async (request, reply) => {
    const item = await itemsService.createItem(request.body.name);
    return reply.status(201).send(item);
  });

  app.delete<{ Params: { id: string } }>("/items/:id", async (request, reply) => {
    await itemsService.deleteItem(request.params.id);
    return reply.status(204).send();
  });
}
