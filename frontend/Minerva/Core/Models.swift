//
//  Models.swift
//  Minerva
//
//  Codable types mirroring openapi.yaml.
//

import Foundation

nonisolated func parseISODate(_ string: String) -> Date? {
    if let date = try? Date(string, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
        return date
    }
    return try? Date(string, strategy: Date.ISO8601FormatStyle())
}

extension JSONDecoder {
    static let api: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let string = try decoder.singleValueContainer().decode(String.self)
            guard let date = parseISODate(string) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Invalid date \(string)")
                )
            }
            return date
        }
        return decoder
    }()
}

struct User: Codable, Equatable {
    let userId: String
    var email: String
    var firstName: String
    var lastName: String
    var studyPreferences: String?
    var createdAt: Date
}

struct Course: Codable, Identifiable, Hashable {
    let courseId: String
    var name: String
    var createdAt: Date
    var id: String { courseId }
}

enum DocType: String, Codable, CaseIterable {
    case assignment, syllabus, textbook, notes, image
}

enum FileStatus: String, Codable {
    case uploaded, parsing, ingesting, ready, failed
}

struct CourseFile: Codable, Identifiable, Hashable {
    let fileId: String
    let courseId: String
    var originalFilename: String
    var title: String
    var docType: DocType
    var summary: String?
    var mimeType: String
    var sizeBytes: Int
    var status: FileStatus
    var error: String?
    var pageCount: Int?
    var createdAt: Date
    var updatedAt: Date
    var id: String { fileId }
}

struct UploadTarget: Codable {
    let url: URL
    let method: String
    let headers: [String: String]
    let expiresAt: Date
}

struct FileRegistration: Codable {
    let file: CourseFile
    let upload: UploadTarget
}

struct DownloadURL: Codable {
    let url: URL
    let expiresAt: Date
}

struct Assignment: Codable, Identifiable, Hashable {
    let assignmentId: String
    let courseId: String
    var title: String
    var description: String
    var dueAt: Date
    var fileIds: [String]
    var completedAt: Date?
    var createdAt: Date
    var id: String { assignmentId }
}

enum ThreadMode: String, Codable, CaseIterable, Identifiable {
    case assignmentHelp = "assignment_help"
    case examPrep = "exam_prep"
    case conceptReview = "concept_review"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .assignmentHelp: "Assignment help"
        case .examPrep: "Exam prep"
        case .conceptReview: "Concept review"
        }
    }
}

struct ChatThread: Codable, Identifiable, Hashable {
    let threadId: String
    let courseId: String
    var title: String
    var mode: ThreadMode
    var assignmentId: String?
    var turnCount: Int
    var pinnedResourceIds: [String]
    var createdAt: Date
    var updatedAt: Date
    var id: String { threadId }
}

enum ContentBlock: Codable, Hashable {
    case text(String)
    case attachment(String)

    private enum CodingKeys: String, CodingKey { case type, text, resourceId }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "resourceRef":
            self = .attachment(try container.decode(String.self, forKey: .resourceId))
        default:
            self = .text(try container.decode(String.self, forKey: .text))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try container.encode("text", forKey: .type)
            try container.encode(text, forKey: .text)
        case .attachment(let id):
            try container.encode("resourceRef", forKey: .type)
            try container.encode(id, forKey: .resourceId)
        }
    }
}

enum MessageRole: String, Codable {
    case user, assistant
}

struct Message: Codable, Identifiable, Hashable {
    let messageId: String
    let role: MessageRole
    let turn: Int
    var contentBlocks: [ContentBlock]
    var id: String { messageId }

    var text: String {
        contentBlocks.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined()
    }

    var attachmentIds: [String] {
        contentBlocks.compactMap { if case .attachment(let id) = $0 { id } else { nil } }
    }
}

struct CourseMatch: Codable {
    let courseName: String
    let courseId: String?
}

// MARK: - Auth

struct TokenPair: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
}

/// A user together with a new session. The tokens sit beside `user` in the JSON.
struct AuthSession: Decodable {
    let user: User
    let tokens: TokenPair

    init(from decoder: Decoder) throws {
        user = try decoder.container(keyedBy: CodingKeys.self).decode(User.self, forKey: .user)
        tokens = try TokenPair(from: decoder)
    }

    private enum CodingKeys: String, CodingKey { case user }
}

// MARK: - Work plans

struct AssignmentRef: Codable, Hashable {
    let courseId: String
    let assignmentId: String
}

struct WorkPlanItem: Codable, Identifiable, Hashable {
    enum Kind: String, Codable { case work, `break` }

    let itemId: String
    var kind: Kind
    var name: String
    var description: String
    var startAt: Date
    var endAt: Date
    var assignment: AssignmentRef?
    var completedAt: Date?
    var id: String { itemId }

    var isWork: Bool { kind == .work }
    var isDone: Bool { completedAt != nil }
}

struct WorkPlan: Codable, Identifiable, Hashable {
    let workPlanId: String
    var startAt: Date
    var endAt: Date
    var timeZone: String
    var workPreferences: String?
    var items: [WorkPlanItem]
    var createdAt: Date
    var id: String { workPlanId }
}

enum ChatEvent {
    case toolStatus(String)
    case text(String)
    case done(messageId: String, turn: Int)
    case error(String)
}

// MARK: - Request bodies

struct RegisterBody: Encodable {
    let email: String
    let password: String
    let firstName: String
    let lastName: String
}

struct LoginBody: Encodable {
    let email: String
    let password: String
}

struct RefreshBody: Encodable {
    let refreshToken: String
}

struct ChangePasswordBody: Encodable {
    let currentPassword: String
    let newPassword: String
}

struct UpdateProfileBody: Encodable {
    let studyPreferences: String?

    // `studyPreferences` is required by the API, so `nil` must go out as an explicit null.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(studyPreferences, forKey: .studyPreferences)
    }

    private enum CodingKeys: String, CodingKey { case studyPreferences }
}

struct CreateCourseBody: Encodable {
    let name: String
}

struct CreateFileBody: Encodable {
    let filename: String
    let mimeType: String
    let sizeBytes: Int
    let docType: DocType?
    var title: String?
}

struct CreateAssignmentBody: Encodable {
    let title: String
    let description: String
    let dueAt: String
}

struct UpdateAssignmentBody: Encodable {
    var title: String?
    var description: String?
    var dueAt: String?
    var completed: Bool?
}

struct CreateThreadBody: Encodable {
    let mode: ThreadMode
    var title: String?
    var assignmentId: String?
    var pinnedResourceIds: [String]?
}

struct SendMessageBody: Encodable {
    let text: String
    var attachmentFileIds: [String]?
}

struct MatchCoursesBody: Encodable {
    let courseNames: [String]
}

struct CreateWorkPlanBody: Encodable {
    let assignmentIds: [String]
    let endAt: String
    let timeZone: String
    var startAt: String?
    var workPreferences: String?
}

struct UpdateWorkPlanItemBody: Encodable {
    let completed: Bool
}
