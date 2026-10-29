//
//  APIClient.swift
//  Minerva
//

import Foundation

struct APIError: LocalizedError {
    let status: Int
    let message: String
    /// Set on a `429` from a locked account: how long until it can be tried again.
    var retryAfterSeconds: Int?

    var errorDescription: String? { message }
    var isUnauthorized: Bool { status == 401 }
}

enum APIConfig {
    /// Where the Minerva API lives. If it moves, change it here.
    static let baseURL = URL(string: "https://knx2epivp2.execute-api.us-east-2.amazonaws.com/prod")!
}

final class APIClient {
    private enum KeychainKey {
        static let access = "accessToken"
        static let refresh = "refreshToken"
    }

    private(set) var accessToken: String? = Keychain.get(KeychainKey.access)
    private(set) var refreshToken: String? = Keychain.get(KeychainKey.refresh)

    /// Called when the server says the session is over (the refresh token can't be used any more).
    var onSessionEnded: (() -> Void)?

    /// The refresh in progress, if any. Only one runs at a time, since a refresh token works once.
    private var refreshTask: Task<String, Error>?

    var hasSession: Bool { refreshToken != nil }

    /// Used for API calls. Not used for S3, which must not receive `Authorization`.
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 180
        return URLSession(configuration: configuration)
    }()

    private var baseURL: URL { APIConfig.baseURL }

    // MARK: Session

    /// Replaces both tokens. A refresh token works once, so the old pair is dead as soon as a new one arrives.
    func store(_ tokens: TokenPair) {
        accessToken = tokens.accessToken
        refreshToken = tokens.refreshToken
        Keychain.set(tokens.accessToken, for: KeychainKey.access)
        Keychain.set(tokens.refreshToken, for: KeychainKey.refresh)
    }

    func clearSession() {
        accessToken = nil
        refreshToken = nil
        Keychain.remove(KeychainKey.access)
        Keychain.remove(KeychainKey.refresh)
    }

    /// Forgets the tokens now and tells the server in the background. The server call is best effort.
    func signOut() {
        let token = refreshToken
        clearSession()
        guard let token, let request = try? makeRequest("POST", "/auth/logout", body: RefreshBody(refreshToken: token)) else { return }
        Task { _ = try? await perform(request, authenticated: false) }
    }

    /// An access token that works, after one was refused. If another request has already refreshed, its
    /// result is used instead of refreshing again, and requests that arrive during a refresh wait for it.
    private func freshAccessToken(after refused: String?) async throws -> String {
        if let accessToken, accessToken != refused { return accessToken }
        if let refreshTask { return try await refreshTask.value }
        guard let token = refreshToken else { throw APIError(status: 401, message: "Please sign in again.") }
        let task = Task { try await self.refresh(using: token) }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    private func refresh(using token: String) async throws -> String {
        let request = try makeRequest("POST", "/auth/refresh", body: RefreshBody(refreshToken: token))
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            // Not retried: the server may have used the token already, and using it twice ends the session.
            throw APIError(status: 0, message: "Couldn't reach the server. Check your connection and try again.")
        }
        if (response as? HTTPURLResponse)?.statusCode == 401 {
            clearSession()
            onSessionEnded?()
            throw APIError(status: 401, message: "Your session has ended. Please sign in again.")
        }
        try Self.validate(response, body: data)
        guard let tokens = try? JSONDecoder.api.decode(TokenPair.self, from: data) else {
            throw APIError(status: 0, message: "The server sent an unexpected response.")
        }
        store(tokens)
        return tokens.accessToken
    }

    // MARK: Core

    private func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil) throws -> URLRequest {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return request
    }

    private func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw error
        } catch {
            throw APIError(status: 0, message: "Couldn't reach the server. Check your connection and try again.")
        }
    }

    /// Sends the request with the access token. If the server refuses it as expired, refreshes and tries once more.
    private func perform(_ request: URLRequest, authenticated: Bool = true) async throws -> Data {
        var request = request
        let sentToken = authenticated ? accessToken : nil
        if let sentToken { request.setValue("Bearer \(sentToken)", forHTTPHeaderField: "Authorization") }
        var (data, response) = try await send(request)
        if authenticated, (response as? HTTPURLResponse)?.statusCode == 401, hasSession {
            let fresh = try await freshAccessToken(after: sentToken)
            request.setValue("Bearer \(fresh)", forHTTPHeaderField: "Authorization")
            (data, response) = try await send(request)
        }
        try Self.validate(response, body: data)
        return data
    }

    private static func validate(_ response: URLResponse, body: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard !(200..<300).contains(http.statusCode) else { return }
        struct Body: Decodable {
            let message: String?
            let retryAfterSeconds: Int?
        }
        let parsed = try? JSONDecoder().decode(Body.self, from: body)
        if http.statusCode == 429 {
            let seconds = parsed?.retryAfterSeconds ?? http.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) }
            if let seconds {
                throw APIError(status: 429, message: "Too many failed attempts. Try again in \(waitText(seconds)).", retryAfterSeconds: seconds)
            }
            throw APIError(status: 429, message: "Too many requests. Wait a moment and try again.")
        }
        throw APIError(status: http.statusCode, message: parsed?.message ?? "Something went wrong (\(http.statusCode)).")
    }

    private static func waitText(_ seconds: Int) -> String {
        if seconds < 60 { return seconds == 1 ? "1 second" : "\(max(seconds, 1)) seconds" }
        let minutes = (seconds + 59) / 60
        return minutes == 1 ? "1 minute" : "\(minutes) minutes"
    }

    private func request<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil, authenticated: Bool = true) async throws -> T {
        let data = try await perform(makeRequest(method, path, query: query, body: body), authenticated: authenticated)
        do {
            return try JSONDecoder.api.decode(T.self, from: data)
        } catch {
            throw APIError(status: 0, message: "The server sent an unexpected response.")
        }
    }

    private struct Wrapped<T: Decodable>: Decodable {
        let courses: T?
        let files: T?
        let assignments: T?
        let threads: T?
        let messages: T?
        let matches: T?
        let workPlans: T?

        var value: T? { courses ?? files ?? assignments ?? threads ?? messages ?? matches ?? workPlans }
    }

    private func requestList<T: Decodable>(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: (any Encodable)? = nil) async throws -> [T] {
        let wrapped: Wrapped<[T]> = try await request(method, path, query: query, body: body)
        return wrapped.value ?? []
    }

    // MARK: Health / users

    func health() async throws {
        let _: [String: String] = try await request("GET", "/health")
    }

    // MARK: Auth

    func register(email: String, password: String, firstName: String, lastName: String) async throws -> AuthSession {
        let session: AuthSession = try await request("POST", "/auth/register", body: RegisterBody(email: email, password: password, firstName: firstName, lastName: lastName), authenticated: false)
        store(session.tokens)
        return session
    }

    func login(email: String, password: String) async throws -> AuthSession {
        let session: AuthSession = try await request("POST", "/auth/login", body: LoginBody(email: email, password: password), authenticated: false)
        store(session.tokens)
        return session
    }

    /// Signs out every session of this account, including other devices, and starts a new one here.
    func changePassword(current: String, new: String) async throws {
        let tokens: TokenPair = try await request("POST", "/auth/change-password", body: ChangePasswordBody(currentPassword: current, newPassword: new))
        store(tokens)
    }

    func me() async throws -> User {
        try await request("GET", "/users/me")
    }

    func updateStudyPreferences(_ text: String?) async throws -> User {
        try await request("PATCH", "/users/me", body: UpdateProfileBody(studyPreferences: text))
    }

    // MARK: Courses

    func listCourses() async throws -> [Course] {
        try await requestList("/courses")
    }

    func createCourse(name: String) async throws -> Course {
        try await request("POST", "/courses", body: CreateCourseBody(name: name))
    }

    func matchCourses(names: [String]) async throws -> [CourseMatch] {
        try await requestList("/courses/match", method: "POST", body: MatchCoursesBody(courseNames: names))
    }

    // MARK: Files

    func listFiles(courseId: String) async throws -> [CourseFile] {
        try await requestList("/courses/\(courseId)/files")
    }

    func getFile(courseId: String, fileId: String) async throws -> CourseFile {
        try await request("GET", "/courses/\(courseId)/files/\(fileId)")
    }

    func createFile(courseId: String, assignmentId: String? = nil, body: CreateFileBody) async throws -> FileRegistration {
        let path = assignmentId.map { "/courses/\(courseId)/assignments/\($0)/files" } ?? "/courses/\(courseId)/files"
        return try await request("POST", path, body: body)
    }

    func downloadURL(courseId: String, fileId: String) async throws -> DownloadURL {
        try await request("GET", "/courses/\(courseId)/files/\(fileId)/download-url")
    }

    /// Sends the bytes straight to S3. No `Authorization` header, and only the headers the API gave us.
    func upload(fileURL: URL, to target: UploadTarget) async throws {
        var request = URLRequest(url: target.url)
        request.httpMethod = target.method
        for (name, value) in target.headers { request.setValue(value, forHTTPHeaderField: name) }
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: fileURL)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            _ = data
            throw APIError(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "The upload didn't go through.")
        }
    }

    // MARK: Assignments

    func listAllAssignments() async throws -> [Assignment] {
        try await requestList("/assignments")
    }

    func createAssignment(courseId: String, title: String, description: String, dueAt: String) async throws -> Assignment {
        try await request("POST", "/courses/\(courseId)/assignments", body: CreateAssignmentBody(title: title, description: description, dueAt: dueAt))
    }

    func updateAssignment(courseId: String, assignmentId: String, changes: UpdateAssignmentBody) async throws -> Assignment {
        try await request("PATCH", "/courses/\(courseId)/assignments/\(assignmentId)", body: changes)
    }

    func deleteAssignment(courseId: String, assignmentId: String) async throws {
        _ = try await perform(makeRequest("DELETE", "/courses/\(courseId)/assignments/\(assignmentId)"))
    }

    // MARK: Work plans

    func listWorkPlans() async throws -> [WorkPlan] {
        try await requestList("/work-plans")
    }

    /// Asks the AI to build and store a plan. This is one ordinary request that can take 10 to 30 seconds.
    func createWorkPlan(_ body: CreateWorkPlanBody) async throws -> WorkPlan {
        try await request("POST", "/work-plans", body: body)
    }

    func updateWorkPlanItem(planId: String, itemId: String, completed: Bool) async throws -> WorkPlan {
        try await request("PATCH", "/work-plans/\(planId)/items/\(itemId)", body: UpdateWorkPlanItemBody(completed: completed))
    }

    func deleteWorkPlan(planId: String) async throws {
        _ = try await perform(makeRequest("DELETE", "/work-plans/\(planId)"))
    }

    // MARK: Threads and chat

    func createThread(courseId: String, body: CreateThreadBody) async throws -> ChatThread {
        try await request("POST", "/courses/\(courseId)/threads", body: body)
    }

    func listThreads(courseId: String) async throws -> [ChatThread] {
        try await requestList("/courses/\(courseId)/threads")
    }

    func listMessages(courseId: String, threadId: String, limit: Int = 200) async throws -> [Message] {
        try await requestList("/courses/\(courseId)/threads/\(threadId)/messages", query: [URLQueryItem(name: "limit", value: String(limit))])
    }

    /// Streams the assistant's reply. Always finishes with `.done` or `.error`, unless the connection drops
    /// first, in which case the stream throws and the caller should refetch the messages.
    func sendMessage(courseId: String, threadId: String, text: String, attachmentFileIds: [String]) -> AsyncThrowingStream<ChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let body = SendMessageBody(text: text, attachmentFileIds: attachmentFileIds.isEmpty ? nil : attachmentFileIds)
                    var request = try makeRequest("POST", "/courses/\(courseId)/threads/\(threadId)/messages", body: body)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                    let sentToken = accessToken
                    if let sentToken { request.setValue("Bearer \(sentToken)", forHTTPHeaderField: "Authorization") }
                    var (bytes, response) = try await session.bytes(for: request)
                    if (response as? HTTPURLResponse)?.statusCode == 401, hasSession {
                        let fresh = try await freshAccessToken(after: sentToken)
                        request.setValue("Bearer \(fresh)", forHTTPHeaderField: "Authorization")
                        (bytes, response) = try await session.bytes(for: request)
                    }
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var collected = Data()
                        for try await byte in bytes { collected.append(byte) }
                        try Self.validate(response, body: collected)
                    }

                    var event = ""
                    var finished = false
                    // Each `data:` line is complete JSON, so emit on it directly instead of waiting for
                    // the blank separator line (`lines` may not deliver empty lines).
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") {
                            event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            let json = Data(line.dropFirst(5).trimmingCharacters(in: .whitespaces).utf8)
                            guard let parsed = Self.parseEvent(name: event, json: json) else { continue }
                            continuation.yield(parsed)
                            switch parsed {
                            case .done, .error: finished = true
                            default: break
                            }
                        }
                        if finished { break }
                    }
                    if finished {
                        continuation.finish()
                    } else {
                        continuation.finish(throwing: APIError(status: 0, message: "The connection ended before the reply finished."))
                    }
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func parseEvent(name: String, json: Data) -> ChatEvent? {
        struct Message: Decodable { let message: String }
        struct Text: Decodable { let text: String }
        struct Done: Decodable { let messageId: String; let turn: Int }
        let decoder = JSONDecoder()
        switch name {
        case "tool_status": return (try? decoder.decode(Message.self, from: json)).map { .toolStatus($0.message) }
        case "text": return (try? decoder.decode(Text.self, from: json)).map { .text($0.text) }
        case "done": return (try? decoder.decode(Done.self, from: json)).map { .done(messageId: $0.messageId, turn: $0.turn) }
        case "error": return (try? decoder.decode(Message.self, from: json)).map { .error($0.message) }
        default: return nil
        }
    }
}
