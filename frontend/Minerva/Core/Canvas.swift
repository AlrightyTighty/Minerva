//
//  Canvas.swift
//  Minerva
//
//  Finding a school, and reading the calendar feed Canvas gives each student.
//

import Foundation

struct CanvasSchool: Identifiable, Hashable {
    let name: String
    /// The school's Canvas address, such as `uh.instructure.com`.
    let host: String
    var id: String { host }

    var initials: String {
        let letters = name.split(whereSeparator: { !$0.isLetter }).filter { $0.first?.isUppercase == true }.prefix(2)
        return letters.compactMap(\.first).map(String.init).joined()
    }
}

struct CanvasEvent: Identifiable, Hashable {
    let id = UUID().uuidString
    let title: String
    /// The course as Canvas writes it, which is what `POST /courses/match` is given. Empty if the event has none.
    let courseName: String
    let due: Date
    let hasTime: Bool
    let detail: String
    let timeNote: String?
}

// MARK: - School search

enum CanvasDirectory {
    private struct Account: Decodable {
        let name: String
        let domain: String?
    }

    /// Instructure's public directory of Canvas schools. It needs no sign-in.
    static func search(_ term: String) async throws -> [CanvasSchool] {
        var components = URLComponents(string: "https://canvas.instructure.com/api/v1/accounts/search")!
        components.queryItems = [URLQueryItem(name: "search_term", value: term)]
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let accounts = try? JSONDecoder().decode([Account].self, from: data) else {
            throw APIError(status: 0, message: "Couldn't search for schools right now.")
        }
        return accounts.compactMap { account in
            guard let domain = account.domain?.trimmingCharacters(in: .whitespaces), !domain.isEmpty else { return nil }
            return CanvasSchool(name: account.name, host: domain.lowercased())
        }
    }
}

// MARK: - Calendar feed

enum CanvasFeed {
    /// Turns what the student pasted, or what Canvas gave us, into an `https` address. `webcal://` is the same thing.
    static func normalize(_ string: String) -> URL? {
        var text = string.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["webcal://", "webcals://", "http://"] where text.lowercased().hasPrefix(prefix) {
            text = "https://" + text.dropFirst(prefix.count)
        }
        guard text.lowercased().hasPrefix("https://"), let url = URL(string: text), url.host != nil else { return nil }
        return url
    }

    /// Downloads the feed and returns its upcoming events. The link works without signing in.
    static func load(_ url: URL, now: Date = .now) async throws -> [CanvasEvent] {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(from: url)
        } catch {
            throw APIError(status: 0, message: "Couldn't download your calendar. Check your connection and try again.")
        }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let text = String(data: data, encoding: .utf8), text.contains("BEGIN:VCALENDAR") else {
            throw APIError(status: 0, message: "That link isn't a calendar feed.")
        }
        return ICalendar.events(from: text, now: now)
    }
}

enum ICalendar {
    private struct Property {
        let name: String
        let params: [String: String]
        let value: String
    }

    /// Upcoming events, soonest first. Events from before today are left out.
    static func events(from text: String, now: Date) -> [CanvasEvent] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        var result: [CanvasEvent] = []
        var seen = Set<String>()

        var current: [Property]?
        var alarmDepth = 0
        for line in unfold(text) {
            switch line {
            case "BEGIN:VEVENT":
                current = []
            case "END:VEVENT":
                if let properties = current, let event = event(from: properties), event.due >= today {
                    let uid = properties.first { $0.name == "UID" }?.value ?? event.id
                    if seen.insert(uid).inserted { result.append(event) }
                }
                current = nil
            case "BEGIN:VALARM":
                alarmDepth += 1
            case "END:VALARM":
                alarmDepth -= 1
            default:
                if current != nil, alarmDepth == 0, let property = property(from: line) { current?.append(property) }
            }
        }
        return Array(result.sorted { $0.due < $1.due }.prefix(300))
    }

    private static func event(from properties: [Property]) -> CanvasEvent? {
        func value(_ name: String) -> String? { properties.first { $0.name == name }.map { unescape($0.value) } }
        guard let start = properties.first(where: { $0.name == "DTSTART" }), let (due, hasTime) = date(from: start),
              let summary = value("SUMMARY")?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty else { return nil }

        // Canvas ends the title with the course in brackets: "Assignment 3 [COSC4355-F26]".
        var title = summary
        var course = ""
        if summary.hasSuffix("]"), let open = summary.lastIndex(of: "["), open != summary.startIndex {
            course = String(summary[summary.index(after: open)..<summary.index(before: summary.endIndex)]).trimmingCharacters(in: .whitespaces)
            title = String(summary[..<open]).trimmingCharacters(in: .whitespaces)
            if title.isEmpty { title = summary; course = "" }
        }

        var detail = (value("DESCRIPTION") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if detail.count > 1000 { detail = String(detail.prefix(1000)) + "…" }
        return CanvasEvent(title: title, courseName: String(course.prefix(200)), due: due, hasTime: hasTime, detail: detail, timeNote: nil)
    }

    // MARK: Parsing

    /// Long lines are folded: a line that starts with a space or tab continues the one before it.
    private static func unfold(_ text: String) -> [String] {
        var lines: [String] = []
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").split(separator: "\n", omittingEmptySubsequences: true) {
            if let first = raw.first, first == " " || first == "\t", !lines.isEmpty {
                lines[lines.count - 1] += raw.dropFirst()
            } else {
                lines.append(String(raw))
            }
        }
        return lines
    }

    private static func property(from line: String) -> Property? {
        var quoted = false
        var colon: String.Index?
        for index in line.indices {
            let character = line[index]
            if character == "\"" { quoted.toggle() }
            if character == ":" && !quoted { colon = index; break }
        }
        guard let colon else { return nil }
        let head = line[..<colon].split(separator: ";", omittingEmptySubsequences: false).map(String.init)
        var params: [String: String] = [:]
        for part in head.dropFirst() {
            let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
            if pair.count == 2 { params[pair[0].uppercased()] = pair[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
        }
        return Property(name: head[0].uppercased(), params: params, value: String(line[line.index(after: colon)...]))
    }

    private static func unescape(_ text: String) -> String {
        guard text.contains("\\") else { return text }
        var result = ""
        var iterator = text.makeIterator()
        while let character = iterator.next() {
            guard character == "\\", let next = iterator.next() else { result.append(character); continue }
            switch next {
            case "n", "N": result.append("\n")
            default: result.append(next)
            }
        }
        return result
    }

    /// A date-only value is an all-day event and keeps its calendar day. A date-time ending in Z is UTC; one with a
    /// `TZID` is in that zone; one with neither is read in the device's zone.
    private static func date(from property: Property) -> (Date, Bool)? {
        let digits = property.value.filter { $0.isNumber }
        guard digits.count >= 8, let year = Int(digits.prefix(4)), let month = Int(digits.dropFirst(4).prefix(2)),
              let day = Int(digits.dropFirst(6).prefix(2)) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        var parts = DateComponents(year: year, month: month, day: day)

        if property.params["VALUE"] == "DATE" || digits.count == 8 {
            calendar.timeZone = .current
            return calendar.date(from: parts).map { ($0, false) }
        }
        guard digits.count >= 12, let hour = Int(digits.dropFirst(8).prefix(2)), let minute = Int(digits.dropFirst(10).prefix(2)) else { return nil }
        parts.hour = hour
        parts.minute = minute
        parts.second = digits.count >= 14 ? Int(digits.dropFirst(12).prefix(2)) : 0
        if property.value.hasSuffix("Z") {
            calendar.timeZone = TimeZone(identifier: "UTC")!
        } else {
            calendar.timeZone = property.params["TZID"].flatMap { TimeZone(identifier: $0) } ?? .current
        }
        return calendar.date(from: parts).map { ($0, true) }
    }
}
