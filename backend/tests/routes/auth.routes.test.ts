import { describe, expect, it } from "vitest";
import { InvalidTokenError } from "../../src/auth/access-tokens.js";
import { AUTH, VALID_TOKEN, buildTestApp } from "../support/test-app.js";

// A caller proves who they are with "Authorization: Bearer <access token>". Every route except /health and the
// /auth endpoints that sign someone in requires it, and routes only ever see the user id inside the verified token.
describe("authentication", () => {
  const protectedRoutes = [
    { method: "GET", url: "/courses" },
    { method: "POST", url: "/courses" },
    { method: "GET", url: "/courses/c1/files" },
    { method: "POST", url: "/courses/c1/files" },
    { method: "GET", url: "/courses/c1/files/f1" },
    { method: "GET", url: "/courses/c1/files/f1/download-url" },
    { method: "POST", url: "/work-plans" },
    { method: "GET", url: "/work-plans" },
    { method: "GET", url: "/work-plans/current" },
    { method: "GET", url: "/work-plans/w1" },
    { method: "PATCH", url: "/work-plans/w1/items/i1" },
    { method: "DELETE", url: "/work-plans/w1" },
    { method: "GET", url: "/users/me" },
    { method: "PATCH", url: "/users/me" },
    { method: "POST", url: "/auth/change-password" },
    { method: "GET", url: "/assignments" },
    { method: "GET", url: "/courses/c1/assignments" },
    { method: "POST", url: "/courses/c1/assignments" },
    { method: "GET", url: "/courses/c1/assignments/a1" },
    { method: "PATCH", url: "/courses/c1/assignments/a1" },
    { method: "DELETE", url: "/courses/c1/assignments/a1" },
    { method: "POST", url: "/courses/match" },
    { method: "POST", url: "/courses/c1/assignments/a1/files" },
    { method: "GET", url: "/courses/c1/threads" },
    { method: "POST", url: "/courses/c1/threads" },
    { method: "GET", url: "/courses/c1/threads/t1" },
    { method: "GET", url: "/courses/c1/threads/t1/messages" },
    { method: "POST", url: "/courses/c1/threads/t1/messages" },
  ] as const;

  const call = (app: ReturnType<typeof buildTestApp>["app"], method: string, url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: method as "GET", url, headers, payload: method === "POST" || method === "PATCH" ? {} : undefined });

  it.each(protectedRoutes)("$method $url returns 401 without a token", async ({ method, url }) => {
    const { app } = buildTestApp();

    expect((await call(app, method, url)).statusCode).toBe(401);
  });

  it.each(protectedRoutes)("$method $url returns 401 for a token that is not valid", async ({ method, url }) => {
    const { app } = buildTestApp();

    const response = await call(app, method, url, { authorization: "Bearer not-a-real-token" });

    expect(response.statusCode).toBe(401);
  });

  it("lets a valid token through and gives the route the user in it", async () => {
    const { app, services } = buildTestApp();
    services.courses.listCourses.mockResolvedValue([]);

    const response = await call(app, "GET", "/courses", AUTH);

    expect(response.statusCode).toBe(200);
    expect(services.tokens.verify).toHaveBeenCalledWith(VALID_TOKEN);
    expect(services.courses.listCourses).toHaveBeenCalledWith("u1");
  });

  it.each([
    ["a scheme that is not Bearer", "Basic dXNlcjpwYXNz"],
    ["a Bearer header with no token", "Bearer"],
    ["a Bearer header with only spaces", "Bearer   "],
    ["a bare token with no scheme", VALID_TOKEN],
    ["two tokens", `Bearer ${VALID_TOKEN} ${VALID_TOKEN}`],
  ])("refuses %s", async (_label, authorization) => {
    const { app } = buildTestApp();

    expect((await call(app, "GET", "/courses", { authorization })).statusCode).toBe(401);
  });

  it("accepts the scheme in any case, as the standard allows", async () => {
    const { app, services } = buildTestApp();
    services.courses.listCourses.mockResolvedValue([]);

    const response = await call(app, "GET", "/courses", { authorization: `bearer ${VALID_TOKEN}` });

    expect(response.statusCode).toBe(200);
  });

  it("refuses an expired token the same way as any other bad one", async () => {
    const { app, services } = buildTestApp();
    services.tokens.verify.mockRejectedValue(new InvalidTokenError());

    const response = await call(app, "GET", "/courses", AUTH);

    expect(response.statusCode).toBe(401);
  });

  it("says nothing about why the token was refused", async () => {
    const { app } = buildTestApp();

    const missing = await call(app, "GET", "/courses");
    const invalid = await call(app, "GET", "/courses", { authorization: "Bearer nope" });

    expect(missing.json()).toEqual(invalid.json());
    expect(missing.json()).toEqual({ message: "Invalid or missing access token" });
  });

  it("tells the client which scheme to use, as the standard asks of a 401", async () => {
    const { app } = buildTestApp();

    const response = await call(app, "GET", "/courses");

    expect(response.headers["www-authenticate"]).toBe("Bearer");
  });

  it("does not read the user from the database on every request", async () => {
    const { app, services } = buildTestApp();
    services.courses.listCourses.mockResolvedValue([]);

    await call(app, "GET", "/courses", AUTH);

    expect(services.users.getUser).not.toHaveBeenCalled();
  });

  it("no longer accepts an x-user-id header, which was only ever a stand-in", async () => {
    const { app } = buildTestApp();

    expect((await call(app, "GET", "/courses", { "x-user-id": "u1" })).statusCode).toBe(401);
  });

  it("ignores an x-user-id header sent alongside a valid token, and acts as the user in the token", async () => {
    const { app, services } = buildTestApp();
    services.courses.listCourses.mockResolvedValue([]);

    await call(app, "GET", "/courses", { ...AUTH, "x-user-id": "someone-else" });

    expect(services.courses.listCourses).toHaveBeenCalledWith("u1");
  });

  it("never lets a request name a different user in the path or body", async () => {
    const { app, services } = buildTestApp();
    services.courses.createCourse.mockResolvedValue({ courseId: "c1", userId: "u1", name: "x", createdAt: "t" });

    await app.inject({
      method: "POST",
      url: "/courses",
      headers: AUTH,
      payload: { name: "Algorithms", userId: "someone-else" },
    });

    expect(services.courses.createCourse).toHaveBeenCalledWith("u1", { name: "Algorithms" });
  });

  describe("routes that need no token", () => {
    it("leaves /health open", async () => {
      const { app } = buildTestApp();

      expect((await call(app, "GET", "/health")).statusCode).toBe(200);
    });

    it.each(["/auth/register", "/auth/login", "/auth/refresh", "/auth/logout"])(
      "leaves POST %s open, since it is how a person gets a token",
      async (url) => {
        const { app } = buildTestApp();

        const response = await call(app, "POST", url);

        // an empty body is a 400 from validation, which means the request got past authentication
        expect(response.statusCode).toBe(400);
      },
    );

    it("no longer has POST /users, which only existed for testing", async () => {
      const { app } = buildTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/users",
        payload: { firstName: "Ada", lastName: "Lovelace" },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
