import { describe, expect, it } from "vitest";
import { CourseMatchUnavailableError } from "../../src/services/course-match.service.js";
import { AUTH, buildTestApp } from "../support/test-app.js";

const match = (app: ReturnType<typeof buildTestApp>["app"], payload: unknown) =>
  app.inject({ method: "POST", url: "/courses/match", headers: AUTH, payload: payload as object });

describe("POST /courses/match", () => {
  it("matches calendar course names to the caller's courses", async () => {
    const { app, services } = buildTestApp();
    services.courseMatch.matchCourses.mockResolvedValue([
      { courseName: "CS3114-F26", courseId: "c1" },
      { courseName: "ENGL 1105", courseId: null },
    ]);

    const response = await match(app, { courseNames: ["CS3114-F26", "ENGL 1105"] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      matches: [
        { courseName: "CS3114-F26", courseId: "c1" },
        { courseName: "ENGL 1105", courseId: null },
      ],
    });
    expect(services.courseMatch.matchCourses).toHaveBeenCalledWith("u1", ["CS3114-F26", "ENGL 1105"]);
  });

  it("returns null, not a missing field, for a name with no match", async () => {
    const { app, services } = buildTestApp();
    services.courseMatch.matchCourses.mockResolvedValue([{ courseName: "ENGL 1105", courseId: null }]);

    const response = await match(app, { courseNames: ["ENGL 1105"] });

    expect(response.json().matches[0]).toHaveProperty("courseId", null);
  });

  it("ignores fields it does not know, such as a user id", async () => {
    const { app, services } = buildTestApp();
    services.courseMatch.matchCourses.mockResolvedValue([]);

    await match(app, { courseNames: ["A"], userId: "someone-else" });

    expect(services.courseMatch.matchCourses).toHaveBeenCalledWith("u1", ["A"]);
  });

  it.each([
    ["no names", {}],
    ["an empty list", { courseNames: [] }],
    ["names that are not a list", { courseNames: "CS3114" }],
    ["a name that is not text", { courseNames: ["CS3114", { name: "x" }] }],
    ["an empty name", { courseNames: [""] }],
    ["a name that is too long", { courseNames: ["x".repeat(201)] }],
    ["too many names", { courseNames: Array.from({ length: 51 }, (_, i) => `Course ${i}`) }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await match(app, payload);

    expect(response.statusCode).toBe(400);
    expect(services.courseMatch.matchCourses).not.toHaveBeenCalled();
  });

  it("accepts the largest allowed list", async () => {
    const { app, services } = buildTestApp();
    services.courseMatch.matchCourses.mockResolvedValue([]);

    const response = await match(app, { courseNames: Array.from({ length: 50 }, (_, i) => `Course ${i}`) });

    expect(response.statusCode).toBe(200);
  });

  it("returns 502 with a message the student can be shown when the AI is unavailable", async () => {
    const { app, services } = buildTestApp();
    services.courseMatch.matchCourses.mockRejectedValue(new CourseMatchUnavailableError());

    const response = await match(app, { courseNames: ["A"] });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ message: "Course matching is unavailable right now. Please try again." });
  });
});
