//
//  PlanStore.swift
//  Minerva
//
//  Work plans live on the server. This keeps the latest copy for the screens.
//

import Foundation
import Observation

extension WorkPlan {
    var zone: TimeZone { TimeZone(identifier: timeZone) ?? .current }

    private var calendar: Calendar {
        var calendar = Calendar.current
        calendar.timeZone = zone
        return calendar
    }

    /// The blocks that can be ticked off. Breaks are only there to be shown.
    var workItems: [WorkPlanItem] { items.filter(\.isWork) }
    var doneCount: Int { workItems.filter(\.isDone).count }
    var isCompleted: Bool { doneCount == workItems.count }
    var fraction: Double { workItems.isEmpty ? 0 : Double(doneCount) / Double(workItems.count) }

    var dayCount: Int {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: startAt), to: calendar.startOfDay(for: endAt)).day ?? 0
        return max(days + 1, 1)
    }

    var rangeText: String {
        let style = Date.FormatStyle(timeZone: zone).month(.abbreviated).day()
        return "\(startAt.formatted(style)) – \(endAt.formatted(style))"
    }

    /// The plan has no title of its own, so one is made from what it covers.
    var title: String {
        let names = workItems.map { $0.name.lowercased() }
        if names.contains(where: { $0.contains("midterm") || $0.contains("exam") || $0.contains("final") }) { return "Exam prep" }
        if names.contains(where: { $0.contains("quiz") }) { return "Quiz week" }
        return "Study plan"
    }

    /// The blocks grouped by the day they start on, read in the plan's own time zone.
    var days: [(day: Date, items: [WorkPlanItem])] {
        let grouped = Dictionary(grouping: items) { calendar.startOfDay(for: $0.startAt) }
        return grouped.keys.sorted().map { ($0, grouped[$0]!.sorted { $0.startAt < $1.startAt }) }
    }

    func dayTitle(_ day: Date) -> String {
        day.formatted(Date.FormatStyle(timeZone: zone).weekday(.wide).month(.abbreviated).day())
    }

    func timeRange(_ item: WorkPlanItem) -> String {
        let style = Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone)
        return "\(item.startAt.formatted(style)) – \(item.endAt.formatted(style))"
    }
}

@Observable
final class PlanStore {
    private let api: APIClient
    private(set) var plans: [WorkPlan] = []
    private(set) var hasLoaded = false

    /// Set by the app to refetch assignments, since completing a plan item can complete its assignment.
    var onItemCompletionChanged: (() async -> Void)?

    init(api: APIClient) {
        self.api = api
    }

    /// The newest plan, which is the one to show first.
    var latest: WorkPlan? { plans.max { $0.createdAt < $1.createdAt } }

    func plan(_ id: String) -> WorkPlan? { plans.first { $0.workPlanId == id } }

    func reset() {
        plans = []
        hasLoaded = false
    }

    func refresh() async {
        guard api.hasSession else { return }
        if let fresh = try? await api.listWorkPlans() { plans = fresh }
        hasLoaded = true
    }

    /// Builds and stores a plan. Takes 10 to 30 seconds, and throws the server's message if the AI couldn't do it.
    func create(assignmentIds: [String], start: Date?, end: Date, preferences: String) async throws -> WorkPlan {
        let text = preferences.trimmingCharacters(in: .whitespacesAndNewlines)
        let plan = try await api.createWorkPlan(CreateWorkPlanBody(
            assignmentIds: assignmentIds,
            endAt: end.formatted(Date.ISO8601FormatStyle()),
            timeZone: TimeZone.current.identifier,
            startAt: start?.formatted(Date.ISO8601FormatStyle()),
            workPreferences: text.isEmpty ? nil : text
        ))
        plans.insert(plan, at: 0)
        return plan
    }

    func setCompleted(_ plan: WorkPlan, item: WorkPlanItem, _ completed: Bool) async throws {
        let updated = try await api.updateWorkPlanItem(planId: plan.workPlanId, itemId: item.itemId, completed: completed)
        replace(updated)
        await onItemCompletionChanged?()
    }

    func delete(_ plan: WorkPlan) async throws {
        try await api.deleteWorkPlan(planId: plan.workPlanId)
        plans.removeAll { $0.workPlanId == plan.workPlanId }
    }

    private func replace(_ plan: WorkPlan) {
        if let index = plans.firstIndex(where: { $0.workPlanId == plan.workPlanId }) {
            plans[index] = plan
        } else {
            plans.insert(plan, at: 0)
        }
    }
}
