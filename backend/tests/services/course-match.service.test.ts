import { describe, expect, it, vi } from "vitest";
import { CourseMatchService, CourseMatchUnavailableError } from "../../src/services/course-match.service.js";

const course = (courseId: string, name: string) => ({
  courseId,
  userId: "u1",
  name,
  createdAt: "2026-10-01T00:00:00.000Z",
});

function build(matches: Array<{ courseName: string; courseId: string | null }> = []) {
  const courses = {
    listCourses: vi.fn().mockResolvedValue([course("c1", "CS 3114 Data Structures"), course("c2", "Calculus II")]),
  };
  const matcher = { match: vi.fn().mockResolvedValue(matches) };
  const service = new CourseMatchService({ courses, matcher } as never);
  return { service, courses, matcher };
}

describe("CourseMatchService.matchCourses", () => {
  it("returns one result per name, in the order given, with null where there is no match", async () => {
    const { service } = build([
      { courseName: "CS3114-F26", courseId: "c1" },
      { courseName: "ENGL 1105", courseId: null },
      { courseName: "MATH 2214", courseId: "c2" },
    ]);

    await expect(service.matchCourses("u1", ["CS3114-F26", "ENGL 1105", "MATH 2214"])).resolves.toEqual([
      { courseName: "CS3114-F26", courseId: "c1" },
      { courseName: "ENGL 1105", courseId: null },
      { courseName: "MATH 2214", courseId: "c2" },
    ]);
  });

  it("offers the matcher only the user's own courses, as ids and names", async () => {
    const { service, courses, matcher } = build([{ courseName: "A", courseId: null }]);

    await service.matchCourses("u1", ["A"]);

    expect(courses.listCourses).toHaveBeenCalledWith("u1");
    expect(matcher.match).toHaveBeenCalledWith({
      courses: [
        { courseId: "c1", name: "CS 3114 Data Structures" },
        { courseId: "c2", name: "Calculus II" },
      ],
      courseNames: ["A"],
    });
  });

  it("echoes each name as it was given, but matches on the trimmed name", async () => {
    const { service, matcher } = build([{ courseName: "CS3114", courseId: "c1" }]);

    const result = await service.matchCourses("u1", ["  CS3114  "]);

    expect(matcher.match.mock.calls[0][0].courseNames).toEqual(["CS3114"]);
    expect(result).toEqual([{ courseName: "  CS3114  ", courseId: "c1" }]);
  });

  it("asks about each distinct name once, and gives repeated names the same answer", async () => {
    const { service, matcher } = build([{ courseName: "CS3114", courseId: "c1" }]);

    const result = await service.matchCourses("u1", ["CS3114", "CS3114"]);

    expect(matcher.match.mock.calls[0][0].courseNames).toEqual(["CS3114"]);
    expect(result.map((r) => r.courseId)).toEqual(["c1", "c1"]);
  });

  it("does not send blank names to the model, and answers null for them", async () => {
    const { service, matcher } = build([{ courseName: "CS3114", courseId: "c1" }]);

    const result = await service.matchCourses("u1", ["   ", "CS3114"]);

    expect(matcher.match.mock.calls[0][0].courseNames).toEqual(["CS3114"]);
    expect(result).toEqual([
      { courseName: "   ", courseId: null },
      { courseName: "CS3114", courseId: "c1" },
    ]);
  });

  it("answers null for an id the model made up, which is not one of the user's courses", async () => {
    const { service } = build([{ courseName: "CS3114", courseId: "c999" }]);

    await expect(service.matchCourses("u1", ["CS3114"])).resolves.toEqual([{ courseName: "CS3114", courseId: null }]);
  });

  it("answers null for a name the model left out of its answer", async () => {
    const { service } = build([{ courseName: "CS3114", courseId: "c1" }]);

    const result = await service.matchCourses("u1", ["CS3114", "ENGL 1105"]);

    expect(result).toEqual([
      { courseName: "CS3114", courseId: "c1" },
      { courseName: "ENGL 1105", courseId: null },
    ]);
  });

  it("lets two different names match the same course", async () => {
    const { service } = build([
      { courseName: "CS3114", courseId: "c1" },
      { courseName: "Data Structures", courseId: "c1" },
    ]);

    const result = await service.matchCourses("u1", ["CS3114", "Data Structures"]);

    expect(result.map((r) => r.courseId)).toEqual(["c1", "c1"]);
  });

  it("answers null for everything, without calling the model, when the user has no courses", async () => {
    const { service, courses, matcher } = build();
    courses.listCourses.mockResolvedValue([]);

    await expect(service.matchCourses("u1", ["A", "B"])).resolves.toEqual([
      { courseName: "A", courseId: null },
      { courseName: "B", courseId: null },
    ]);

    expect(matcher.match).not.toHaveBeenCalled();
  });

  it("returns an empty list, without calling the model, for an empty list", async () => {
    const { service, matcher } = build();

    await expect(service.matchCourses("u1", [])).resolves.toEqual([]);

    expect(matcher.match).not.toHaveBeenCalled();
  });

  it("reports a failing model as unavailable, without leaking the reason", async () => {
    const { service, matcher } = build();
    matcher.match.mockRejectedValue(new Error("ThrottlingException: secret internals"));

    const attempt = service.matchCourses("u1", ["A"]);

    await expect(attempt).rejects.toThrow(CourseMatchUnavailableError);
    await expect(attempt).rejects.not.toThrow(/secret internals/);
  });
});
