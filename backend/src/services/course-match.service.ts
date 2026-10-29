import type { CourseMatch, CourseMatcher } from "../clients/course-matcher.js";
import type { CoursesService } from "./courses.service.js";

/** Matching needs the AI, which is not available right now. */
export class CourseMatchUnavailableError extends Error {
  constructor() {
    super("Course matching is unavailable right now. Please try again.");
  }
}

export interface CourseMatchServiceDeps {
  courses: Pick<CoursesService, "listCourses">;
  matcher: CourseMatcher;
}

export class CourseMatchService {
  constructor(private readonly deps: CourseMatchServiceDeps) {}

  /**
   * Matches names from a calendar to the user's own courses, one result per name, in order.
   * The AI only ever sees the user's courses, and an id it returns that is not one of them counts as no match.
   */
  async matchCourses(userId: string, courseNames: string[]): Promise<CourseMatch[]> {
    if (courseNames.length === 0) {
      return [];
    }

    const courses = await this.deps.courses.listCourses(userId);
    const distinct = [...new Set(courseNames.map((name) => name.trim()).filter((name) => name !== ""))];

    let answers = new Map<string, string>();
    if (courses.length > 0 && distinct.length > 0) {
      const known = new Set(courses.map((course) => course.courseId));
      let matches: CourseMatch[];
      try {
        matches = await this.deps.matcher.match({
          courses: courses.map(({ courseId, name }) => ({ courseId, name })),
          courseNames: distinct,
        });
      } catch (err) {
        console.error(JSON.stringify({ job: "course-match", error: err instanceof Error ? err.message : String(err) }));
        throw new CourseMatchUnavailableError();
      }
      answers = new Map(
        matches.flatMap((match) =>
          match.courseId !== null && known.has(match.courseId) ? [[match.courseName.trim(), match.courseId] as const] : [],
        ),
      );
    }

    return courseNames.map((courseName) => ({ courseName, courseId: answers.get(courseName.trim()) ?? null }));
  }
}
