import { describe, expect, it, vi } from "vitest";
import { ItemNotFoundError, ItemsService } from "../../src/services/items.service.js";
import type { Item, ItemsRepository } from "../../src/repositories/items.repository.js";

function createRepositoryMock(overrides: Partial<ItemsRepository> = {}): ItemsRepository {
  return {
    getById: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  } as unknown as ItemsRepository;
}

describe("ItemsService", () => {
  it("returns an item when the repository finds one", async () => {
    const item: Item = { id: "1", name: "widget", createdAt: new Date().toISOString() };
    const repository = createRepositoryMock({ getById: vi.fn().mockResolvedValue(item) });
    const service = new ItemsService(repository);

    await expect(service.getItem("1")).resolves.toEqual(item);
  });

  it("throws ItemNotFoundError when the repository finds nothing", async () => {
    const repository = createRepositoryMock({ getById: vi.fn().mockResolvedValue(undefined) });
    const service = new ItemsService(repository);

    await expect(service.getItem("missing")).rejects.toThrow(ItemNotFoundError);
  });

  it("creates and persists a new item", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const repository = createRepositoryMock({ put });
    const service = new ItemsService(repository);

    const item = await service.createItem("widget");

    expect(item.name).toBe("widget");
    expect(put).toHaveBeenCalledWith(item);
  });
});
