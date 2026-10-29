import { describe, expect, it, vi } from "vitest";
import type { Course } from "../../src/models/items.js";
import { CourseNotFoundError, CoursesService } from "../../src/services/courses.service.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");

const course = (overrides: Partial<Course> = {}): Course => ({
  courseId: "c1",
  userId: "u1",
  name: "Algorithms",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

function build() {
  const courses = { create: vi.fn().mockResolvedValue(true), get: vi.fn(), listByUser: vi.fn() };
  const service = new CoursesService({ courses, newId: () => "c-new", now: () => NOW } as never);
  return { service, courses };
}

describe("CoursesService", () => {
  it("creates a course owned by the user", async () => {
    const { service, courses } = build();

    const created = await service.createCourse("u1", { name: "Algorithms" });

    expect(created).toEqual({
      courseId: "c-new",
      userId: "u1",
      name: "Algorithms",
      createdAt: "2026-10-26T12:00:00.000Z",
    });
    expect(courses.create).toHaveBeenCalledWith(created);
  });

  it("lists only the user's courses that are not deleted", async () => {
    const { service, courses } = build();
    courses.listByUser.mockResolvedValue([
      course(),
      course({ courseId: "c2", deletedAt: "2026-10-20T00:00:00.000Z" }),
      course({ courseId: "c3" }),
    ]);

    const result = await service.listCourses("u1");

    expect(courses.listByUser).toHaveBeenCalledWith("u1");
    expect(result.map((c) => c.courseId)).toEqual(["c1", "c3"]);
  });

  it("gets a course by id", async () => {
    const { service, courses } = build();
    courses.get.mockResolvedValue(course());

    await expect(service.getCourse("u1", "c1")).resolves.toEqual(course());
    expect(courses.get).toHaveBeenCalledWith("u1", "c1");
  });

  it("throws CourseNotFoundError when the course does not exist for that user", async () => {
    const { service, courses } = build();
    courses.get.mockResolvedValue(undefined);

    await expect(service.getCourse("u1", "c9")).rejects.toThrow(CourseNotFoundError);
  });

  it("treats a soft-deleted course as not found", async () => {
    const { service, courses } = build();
    courses.get.mockResolvedValue(course({ deletedAt: "2026-10-20T00:00:00.000Z" }));

    await expect(service.getCourse("u1", "c1")).rejects.toThrow(CourseNotFoundError);
  });
});
