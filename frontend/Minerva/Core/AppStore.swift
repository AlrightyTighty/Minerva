//
//  AppStore.swift
//  Minerva
//

import Foundation
import Observation

@Observable
final class AppStore {
    let api = APIClient()

    private(set) var user: User?
    private(set) var courses: [Course] = []
    private(set) var assignments: [Assignment] = []
    private(set) var threadsByCourse: [String: [ChatThread]] = [:]
    private(set) var courseMeta: [String: CourseMeta]
    private(set) var personalItems: [PersonalItem]
    private(set) var canvasAssignmentIds: Set<String>
    private(set) var uploadJobs: [UploadJob] = []
    private(set) var hasLoaded = false

    /// Set by the app to refetch work plans, since completing an assignment completes its plan items.
    var onAssignmentCompletionChanged: (() async -> Void)?

    private(set) var isSignedIn: Bool

    /// Called whenever the session ends, whether the student signed out or the server ended it.
    var onSignedOut: (() -> Void)?

    var setupDone: Bool
    var savedPrefs: StudyPrefs

    init() {
        courseMeta = Defaults.load([String: CourseMeta].self, key: "minerva.courseMeta") ?? [:]
        personalItems = Defaults.load([PersonalItem].self, key: "minerva.personalItems") ?? []
        canvasAssignmentIds = Defaults.load(Set<String>.self, key: "minerva.canvasIds") ?? []
        setupDone = UserDefaults.standard.bool(forKey: "minerva.setupDone")
        savedPrefs = Defaults.load(StudyPrefs.self, key: "minerva.savedPrefs") ?? StudyPrefs()
        isSignedIn = api.hasSession

        // The Keychain outlives an uninstall but UserDefaults doesn't, so tokens with no local owner are left over.
        UserDefaults.standard.removeObject(forKey: "minerva.userId")
        if isSignedIn, UserDefaults.standard.string(forKey: Self.ownerKey) == nil {
            api.clearSession()
            isSignedIn = false
        }
        api.onSessionEnded = { [weak self] in self?.sessionEnded() }
    }

    private static let ownerKey = "minerva.localOwner"

    // MARK: Session

    func signUp(firstName: String, lastName: String, email: String, password: String) async throws {
        begin(try await api.register(email: email, password: password, firstName: firstName, lastName: lastName))
    }

    func signIn(email: String, password: String) async throws {
        begin(try await api.login(email: email, password: password))
        // An account that already has courses has been through setup, on this device or another.
        if let existing = try? await api.listCourses(), !existing.isEmpty { completeSetup() }
    }

    /// Starts using a new session. Data kept on the device belongs to whoever used it last, so another account never sees it.
    private func begin(_ session: AuthSession) {
        if UserDefaults.standard.string(forKey: Self.ownerKey) != session.user.userId { wipeLocalData() }
        UserDefaults.standard.set(session.user.userId, forKey: Self.ownerKey)
        user = session.user
        hasLoaded = true
        isSignedIn = true
    }

    /// The student chose to sign out. Everything kept on the device for them is removed.
    func signOut() {
        api.signOut()
        wipeLocalData()
        isSignedIn = false
        onSignedOut?()
    }

    /// The server ended the session (the refresh token expired or was revoked). Local data stays, so signing
    /// back in as the same student picks up where they left off.
    private func sessionEnded() {
        user = nil
        hasLoaded = false
        isSignedIn = false
        onSignedOut?()
    }

    private func wipeLocalData() {
        Defaults.clearAll()
        user = nil
        courses = []
        assignments = []
        threadsByCourse = [:]
        courseMeta = [:]
        personalItems = []
        canvasAssignmentIds = []
        uploadJobs = []
        setupDone = false
        savedPrefs = StudyPrefs()
        hasLoaded = false
    }

    func completeSetup() {
        setupDone = true
        UserDefaults.standard.set(true, forKey: "minerva.setupDone")
    }

    /// Reloads everything the screens show. A 401 means the stored user is gone, so sign out.
    func refresh() async {
        guard isSignedIn else { return }
        do {
            async let me = api.me()
            async let courses = api.listCourses()
            async let assignments = api.listAllAssignments()
            self.user = try await me
            self.courses = try await courses
            self.assignments = try await assignments
            hasLoaded = true
            await refreshThreads()
        } catch let error as APIError where error.isUnauthorized {
            // The client already handled the session ending.
        } catch {
            hasLoaded = true
        }
    }

    /// Refetches just the assignments, after a work plan item changed one.
    func refreshAssignments() async {
        if let fresh = try? await api.listAllAssignments() { assignments = fresh }
    }

    func refreshThreads() async {
        var result: [String: [ChatThread]] = [:]
        await withTaskGroup(of: (String, [ChatThread]?).self) { group in
            for course in courses {
                group.addTask { [api] in (course.courseId, try? await api.listThreads(courseId: course.courseId)) }
            }
            for await (courseId, threads) in group {
                result[courseId] = threads ?? threadsByCourse[courseId] ?? []
            }
        }
        threadsByCourse = result
    }

    var firstName: String { user?.firstName ?? "" }

    // MARK: Courses

    func course(_ id: String?) -> Course? {
        guard let id else { return nil }
        return courses.first { $0.courseId == id }
    }

    func displayName(_ courseId: String?) -> String {
        guard let courseId else { return "No course" }
        return courseMeta[courseId]?.name ?? course(courseId)?.name ?? "Course"
    }

    func code(_ courseId: String?) -> String? {
        guard let courseId, let code = courseMeta[courseId]?.code, !code.isEmpty else { return nil }
        return code
    }

    /// The short label shown next to an item: the course code if there is one, otherwise its name.
    func courseLabel(_ courseId: String?) -> String {
        code(courseId) ?? displayName(courseId)
    }

    func term(_ courseId: String) -> String? {
        guard let term = courseMeta[courseId]?.term, !term.isEmpty else { return nil }
        return term
    }

    func initials(_ courseId: String?) -> String {
        let source = code(courseId).map { String($0.prefix(2)) } ?? displayName(courseId)
        let words = source.split(separator: " ").prefix(2)
        let letters = words.count == 2 ? words.compactMap(\.first).map(String.init).joined() : String(source.prefix(2))
        return letters.uppercased()
    }

    /// The name the API stores. It includes the code so the AI that matches calendar names has more to go on.
    private func serverName(name: String, code: String) -> String {
        code.isEmpty ? name : "\(code) \(name)"
    }

    @discardableResult
    func createCourse(name: String, code: String, term: String, syllabus: PickedFile?, materials: [PickedFile]) async throws -> Course {
        let course = try await api.createCourse(name: serverName(name: name, code: code))
        courses.append(course)
        courseMeta[course.courseId] = CourseMeta(name: name, code: code, term: term)
        saveMeta()
        if let syllabus { enqueue(UploadJob(courseId: course.courseId, file: syllabus, docType: .syllabus)) }
        for file in materials { enqueue(UploadJob(courseId: course.courseId, file: file, docType: .textbook)) }
        return course
    }

    /// The course that holds chats and uploads that aren't about a specific course.
    func generalCourse() async throws -> Course {
        if let id = UserDefaults.standard.string(forKey: "minerva.generalCourseId"), let existing = course(id) {
            return existing
        }
        let course = try await api.createCourse(name: "General")
        courses.append(course)
        courseMeta[course.courseId] = CourseMeta(name: "General", code: "", term: "")
        saveMeta()
        UserDefaults.standard.set(course.courseId, forKey: "minerva.generalCourseId")
        return course
    }

    /// Courses a student chooses between (the hidden general course is left out).
    var pickableCourses: [Course] {
        let general = UserDefaults.standard.string(forKey: "minerva.generalCourseId")
        return courses.filter { $0.courseId != general }
    }

    private func saveMeta() { Defaults.save(courseMeta, key: "minerva.courseMeta") }

    // MARK: Uploads

    func jobs(for courseId: String) -> [UploadJob] {
        uploadJobs.filter { $0.courseId == courseId }
    }

    func enqueue(_ job: UploadJob) {
        uploadJobs.append(job)
        Task { await run(job) }
    }

    func retry(_ job: UploadJob) {
        job.state = .uploading
        Task { await run(job) }
    }

    /// Registers the file, sends the bytes to S3, then polls until the server has processed it.
    func run(_ job: UploadJob) async {
        do {
            let registration = try await api.createFile(
                courseId: job.courseId,
                assignmentId: job.assignmentId,
                body: CreateFileBody(filename: job.file.filename, mimeType: job.file.mimeType, sizeBytes: job.file.sizeBytes, docType: job.docType, title: job.title)
            )
            job.fileId = registration.file.fileId
            try await api.upload(fileURL: job.file.url, to: registration.upload)
            job.state = .processing(.uploaded)

            for _ in 0..<200 {
                try await Task.sleep(for: .seconds(3))
                let file = try await api.getFile(courseId: job.courseId, fileId: registration.file.fileId)
                switch file.status {
                case .ready:
                    job.state = .ready
                    return
                case .failed:
                    job.state = .failed(file.error ?? "Processing failed.")
                    return
                default:
                    job.state = .processing(file.status)
                }
            }
            job.state = .failed("Processing is taking longer than expected.")
        } catch is CancellationError {
            return
        } catch {
            job.state = .failed(error.localizedDescription)
        }
    }

    /// Waits for a job to finish. Used before attaching a file to a chat, which needs it `ready`.
    func waitUntilFinished(_ job: UploadJob) async throws {
        while !job.isFinished {
            try await Task.sleep(for: .milliseconds(500))
        }
        if case .failed(let message) = job.state { throw APIError(status: 0, message: message) }
    }

    // MARK: Calendar items

    var calendarItems: [CalendarItem] {
        let fromAPI = assignments.map { assignment in
            CalendarItem(
                id: assignment.assignmentId,
                kind: .assignment(courseId: assignment.courseId, assignmentId: assignment.assignmentId),
                title: assignment.title,
                description: assignment.description,
                due: assignment.dueAt,
                hasTime: DueDateFormat.hasTime(assignment.dueAt),
                completed: assignment.completedAt != nil,
                fromCanvas: canvasAssignmentIds.contains(assignment.assignmentId)
            )
        }
        let local = personalItems.map { item in
            CalendarItem(id: item.id, kind: .personal, title: item.title, description: item.description, due: item.due, hasTime: item.hasTime, completed: item.completed, fromCanvas: item.fromCanvas)
        }
        return (fromAPI + local).sorted { $0.due < $1.due }
    }

    func item(_ id: String) -> CalendarItem? {
        calendarItems.first { $0.id == id }
    }

    func addItem(title: String, description: String, day: Date, time: Date?, courseId: String?, fromCanvas: Bool = false) async throws {
        let due = DueDateFormat.apiString(day: day, time: time)
        if let courseId {
            let created = try await api.createAssignment(courseId: courseId, title: title, description: description, dueAt: due)
            assignments.append(created)
            if fromCanvas {
                canvasAssignmentIds.insert(created.assignmentId)
                Defaults.save(canvasAssignmentIds, key: "minerva.canvasIds")
            }
        } else {
            let date = parseISODate(due.count == 10 ? due + "T00:00:00Z" : due) ?? day
            personalItems.append(PersonalItem(title: title, description: description, due: date, hasTime: time != nil, fromCanvas: fromCanvas))
            savePersonal()
        }
    }

    func updateItem(_ item: CalendarItem, title: String, description: String, day: Date, time: Date?) async throws {
        switch item.kind {
        case .assignment(let courseId, let assignmentId):
            let updated = try await api.updateAssignment(
                courseId: courseId,
                assignmentId: assignmentId,
                changes: UpdateAssignmentBody(title: title, description: description, dueAt: DueDateFormat.apiString(day: day, time: time))
            )
            replace(updated)
        case .personal:
            guard let index = personalItems.firstIndex(where: { $0.id == item.id }) else { return }
            let due = DueDateFormat.apiString(day: day, time: time)
            personalItems[index].title = title
            personalItems[index].description = description
            personalItems[index].due = parseISODate(due.count == 10 ? due + "T00:00:00Z" : due) ?? day
            personalItems[index].hasTime = time != nil
            savePersonal()
        }
    }

    func setCompleted(_ item: CalendarItem, _ completed: Bool) async throws {
        switch item.kind {
        case .assignment(let courseId, let assignmentId):
            let updated = try await api.updateAssignment(courseId: courseId, assignmentId: assignmentId, changes: UpdateAssignmentBody(completed: completed))
            replace(updated)
            await onAssignmentCompletionChanged?()
        case .personal:
            guard let index = personalItems.firstIndex(where: { $0.id == item.id }) else { return }
            personalItems[index].completed = completed
            savePersonal()
        }
    }

    func delete(_ item: CalendarItem) async throws {
        switch item.kind {
        case .assignment(let courseId, let assignmentId):
            try await api.deleteAssignment(courseId: courseId, assignmentId: assignmentId)
            assignments.removeAll { $0.assignmentId == assignmentId }
        case .personal:
            personalItems.removeAll { $0.id == item.id }
            savePersonal()
        }
    }

    private func replace(_ assignment: Assignment) {
        if let index = assignments.firstIndex(where: { $0.assignmentId == assignment.assignmentId }) {
            assignments[index] = assignment
        }
    }

    private func savePersonal() { Defaults.save(personalItems, key: "minerva.personalItems") }

    // MARK: Canvas import

    /// Asks the API which Minerva course each calendar course name refers to. Names with no confident
    /// match come back as `nil`; the caller lets the student choose.
    func matchCourses(names: [String]) async throws -> [String: String?] {
        let distinct = Array(Set(names.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }))
        var result: [String: String?] = Dictionary(names.map { ($0, String?.none) }, uniquingKeysWith: { first, _ in first })
        guard !distinct.isEmpty, !courses.isEmpty else { return result }
        // The API takes at most 50 names at a time.
        for start in stride(from: 0, to: distinct.count, by: 50) {
            let batch = Array(distinct[start..<min(start + 50, distinct.count)])
            for match in try await api.matchCourses(names: batch) { result[match.courseName] = match.courseId }
        }
        return result
    }

    // MARK: Study preferences

    func savePreferences(_ prefs: StudyPrefs) async throws {
        user = try await api.updateStudyPreferences(prefs.summaryForAssistant)
        savedPrefs = prefs
        Defaults.save(prefs, key: "minerva.savedPrefs")
    }

    func updateStudyPreferences(_ text: String?) async throws {
        user = try await api.updateStudyPreferences(text)
    }

    // MARK: Chat

    var recentThreads: [ChatThread] {
        threadsByCourse.values.flatMap { $0 }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func startThread(courseId: String, mode: ThreadMode, title: String, assignmentId: String?, pinned: [String]) async throws -> ChatThread {
        let thread = try await api.createThread(
            courseId: courseId,
            body: CreateThreadBody(mode: mode, title: title, assignmentId: assignmentId, pinnedResourceIds: pinned.isEmpty ? nil : pinned)
        )
        threadsByCourse[courseId, default: []].insert(thread, at: 0)
        return thread
    }

    func touch(_ thread: ChatThread) {
        guard var list = threadsByCourse[thread.courseId], let index = list.firstIndex(where: { $0.threadId == thread.threadId }) else { return }
        list[index].updatedAt = .now
        list[index].turnCount += 1
        threadsByCourse[thread.courseId] = list
    }
}
