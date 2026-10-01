import { randomUUID } from "node:crypto";
import type { Item, ItemsRepository } from "../repositories/items.repository.js";

export class ItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Item "${id}" not found`);
  }
}

export class ItemsService {
  constructor(private readonly itemsRepository: ItemsRepository) {}

  async getItem(id: string): Promise<Item> {
    const item = await this.itemsRepository.getById(id);
    if (!item) {
      throw new ItemNotFoundError(id);
    }
    return item;
  }

  async createItem(name: string): Promise<Item> {
    const item: Item = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
    };
    await this.itemsRepository.put(item);
    return item;
  }

  async deleteItem(id: string): Promise<void> {
    await this.itemsRepository.delete(id);
  }
}
