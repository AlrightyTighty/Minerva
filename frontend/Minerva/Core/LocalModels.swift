//
//  LocalModels.swift
//  Minerva
//
//  Things the API has no home for, kept on the device.
//

import Foundation
import UniformTypeIdentifiers

enum Defaults {
    static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    static func save<T: Encodable>(_ value: T, key: String) {
        UserDefaults.standard.set(try? JSONEncoder().encode(value), forKey: key)
    }

    static func clearAll() {
        let keys = [
            "minerva.localOwner", "minerva.courseMeta", "minerva.personalItems", "minerva.canvasIds",
            "minerva.setupDone", "minerva.savedPrefs", "minerva.generalCourseId",
        ]
        keys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
    }
}

/// Course details the API doesn't store (it only has `name`).
struct CourseMeta: Codable, Hashable {
    var name: String
    var code: String
    var term: String
}

/// A calendar item with no course. Assignments need a course in the API, so these stay on the device.
struct PersonalItem: Codable, Identifiable, Hashable {
    var id = UUID().uuidString
    var title: String
    var description = ""
    var due: Date
    var hasTime: Bool
    var completed = false
    var fromCanvas = false
}

/// One row on the calendar, whether it came from the API or the device.
struct CalendarItem: Identifiable, Hashable {
    enum Kind: Hashable { case assignment(courseId: String, assignmentId: String), personal }

    let id: String
    var kind: Kind
    var title: String
    var description: String
    var due: Date
    var hasTime: Bool
    var completed: Bool
    var fromCanvas: Bool

    var courseId: String? {
        if case .assignment(let courseId, _) = kind { courseId } else { nil }
    }

    var assignmentId: String? {
        if case .assignment(_, let assignmentId) = kind { assignmentId } else { nil }
    }

    /// The calendar day this item falls on. Items with no time are stored as midnight UTC, so their day is
    /// read in UTC rather than shifting to the evening before in US time zones.
    var day: Date {
        var calendar = Calendar.current
        if !hasTime { calendar.timeZone = TimeZone(identifier: "UTC")! }
        let parts = calendar.dateComponents([.year, .month, .day], from: due)
        return Calendar.current.date(from: parts) ?? due
    }

    var timeText: String? {
        hasTime ? due.formatted(date: .omitted, time: .shortened) : nil
    }
}

enum DueDateFormat {
    static func apiString(day: Date, time: Date?) -> String {
        let calendar = Calendar.current
        let parts = calendar.dateComponents([.year, .month, .day], from: day)
        if let time {
            let clock = calendar.dateComponents([.hour, .minute], from: time)
            var merged = parts
            merged.hour = clock.hour
            merged.minute = clock.minute
            let date = calendar.date(from: merged) ?? day
            return date.formatted(Date.ISO8601FormatStyle())
        }
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    static func hasTime(_ date: Date) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents([.hour, .minute, .second], from: date)
        return !(parts.hour == 0 && parts.minute == 0 && parts.second == 0)
    }
}

extension Date {
    var dayTitle: String { formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()) }
    var shortDay: String { formatted(.dateTime.month(.abbreviated).day()) }

    /// "Today", "Yesterday", a weekday within the last week, otherwise a short date.
    var relativeDay: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(self) { return "Today" }
        if calendar.isDateInYesterday(self) { return "Yesterday" }
        if let days = calendar.dateComponents([.day], from: self, to: .now).day, days < 7 {
            return formatted(.dateTime.weekday(.wide))
        }
        return shortDay
    }
}

// MARK: - Picked files

struct PickedFile: Identifiable, Hashable {
    let id = UUID()
    let url: URL
    let filename: String
    let mimeType: String
    let sizeBytes: Int

    var isImage: Bool { mimeType.hasPrefix("image/") }
    var docTypeDefault: DocType { isImage ? .image : .notes }

    var sizeText: String {
        ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file)
    }

    static let maxImageBytes = 3_932_160
    static let allowedTypes: [UTType] = [.pdf, .png, .jpeg, .webP, .gif]
    static let pdfOnly: [UTType] = [.pdf]

    private static let mimeByExtension = [
        "pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "webp": "image/webp", "gif": "image/gif",
    ]

    /// Copies the picked file into the app's temp directory (the picker's URL is security-scoped and
    /// short-lived) and checks it against the API's upload rules so the student gets a clear message early.
    static func make(from source: URL, allowImages: Bool) throws -> PickedFile {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }

        let ext = source.pathExtension.lowercased()
        guard let mime = mimeByExtension[ext], allowImages || mime == "application/pdf" else {
            throw APIError(status: 400, message: allowImages
                ? "Only PDF and image (PNG, JPEG, WebP, GIF) files can be uploaded."
                : "Only PDF files can be uploaded here.")
        }

        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appending(path: source.lastPathComponent)
        try FileManager.default.copyItem(at: source, to: destination)

        let size = (try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size == 0 { throw APIError(status: 400, message: "That file is empty.") }
        if mime.hasPrefix("image/") && size > maxImageBytes {
            throw APIError(status: 400, message: "Images must be 3.75 MB or smaller.")
        }
        if size > 500 * 1_048_576 {
            throw APIError(status: 400, message: "PDFs must be 500 MB or smaller.")
        }
        return PickedFile(url: destination, filename: source.lastPathComponent, mimeType: mime, sizeBytes: size)
    }
}

// MARK: - Study preferences (setup answers)

struct StudyPrefs: Codable, Hashable {
    var breaks = ""
    var explanations = ""
    var practice = ""
    var times = ""
    var other = ""

    var isEmpty: Bool { [breaks, explanations, practice, times, other].allSatisfy { $0.trimmingCharacters(in: .whitespaces).isEmpty } }

    /// The text sent to the assistant as `studyPreferences`. The API caps it at 500 characters.
    var summaryForAssistant: String? {
        let parts = [
            explanations.isEmpty ? nil : "Explanations: \(explanations)",
            practice.isEmpty ? nil : "Practice problems: \(practice)",
            breaks.isEmpty ? nil : "Breaks: \(breaks)",
            times.isEmpty ? nil : "Study times: \(times)",
            other.isEmpty ? nil : other,
        ].compactMap { $0 }
        guard !parts.isEmpty else { return nil }
        return String(parts.joined(separator: ". ").prefix(500))
    }
}
