import { describe, expect, it } from "vitest";
import type { Course } from "../../src/models/items.js";
import { AUTH, buildTestApp } from "../support/test-app.js";

const course: Course = {
  courseId: "c1",
  userId: "u1",
  name: "Algorithms",
  createdAt: "2026-10-26T00:00:00.000Z",
};

// the response never includes userId (the caller is the owner) or deletedAt
const courseResponse = { courseId: "c1", name: "Algorithms", createdAt: "2026-10-26T00:00:00.000Z" };

describe("POST /courses", () => {
  it("creates a course for the caller", async () => {
    const { app, services } = buildTestApp();
    services.courses.createCourse.mockResolvedValue(course);

    const response = await app.inject({
      method: "POST",
      url: "/courses",
      headers: AUTH,
      payload: { name: "Algorithms" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(courseResponse);
    expect(services.courses.createCourse).toHaveBeenCalledWith("u1", { name: "Algorithms" });
  });

  it.each([
    ["a missing name", {}],
    ["an empty name", { name: "" }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await app.inject({ method: "POST", url: "/courses", headers: AUTH, payload });

    expect(response.statusCode).toBe(400);
    expect(services.courses.createCourse).not.toHaveBeenCalled();
  });
});

describe("GET /courses", () => {
  it("lists the caller's courses", async () => {
    const { app, services } = buildTestApp();
    services.courses.listCourses.mockResolvedValue([course, { ...course, courseId: "c2", name: "Databases" }]);

    const response = await app.inject({ method: "GET", url: "/courses", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      courses: [courseResponse, { ...courseResponse, courseId: "c2", name: "Databases" }],
    });
  });

  it("returns an empty list when there are none", async () => {
    const { app, services } = buildTestApp();
    services.courses.listCourses.mockResolvedValue([]);

    const response = await app.inject({ method: "GET", url: "/courses", headers: AUTH });

    expect(response.json()).toEqual({ courses: [] });
  });
});
