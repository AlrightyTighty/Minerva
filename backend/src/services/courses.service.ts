import type { Course } from "../models/items.js";
import type { CoursesRepository } from "../repositories/courses.repository.js";

export class CourseNotFoundError extends Error {
  constructor(courseId: string) {
    super(`Course "${courseId}" not found`);
  }
}

export interface CoursesServiceDeps {
  courses: CoursesRepository;
  newId: () => string;
  now: () => Date;
}

export class CoursesService {
  constructor(private readonly deps: CoursesServiceDeps) {}

  async createCourse(userId: string, input: { name: string }): Promise<Course> {
    const course: Course = {
      courseId: this.deps.newId(),
      userId,
      name: input.name,
      createdAt: this.deps.now().toISOString(),
    };
    if (!(await this.deps.courses.create(course))) {
      throw new Error(`Course id collision for ${course.courseId}`);
    }
    return course;
  }

  async listCourses(userId: string): Promise<Course[]> {
    const courses = await this.deps.courses.listByUser(userId);
    return courses.filter((course) => !course.deletedAt);
  }

  /** A course that is missing, belongs to someone else (the key includes the user) or is soft-deleted is "not found". */
  async getCourse(userId: string, courseId: string): Promise<Course> {
    const course = await this.deps.courses.get(userId, courseId);
    if (!course || course.deletedAt) {
      throw new CourseNotFoundError(courseId);
    }
    return course;
  }
}
