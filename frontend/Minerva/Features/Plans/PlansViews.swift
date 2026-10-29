//
//  PlansViews.swift
//  Minerva
//

import SwiftUI

/// One block of a plan. Work blocks can be ticked off (which can complete the assignment); breaks just show.
struct PlanItemRow: View {
    @Environment(AppStore.self) private var store
    @Environment(PlanStore.self) private var plans
    @Environment(Router.self) private var router
    let plan: WorkPlan
    let item: WorkPlanItem
    var showHelp = true
    var showDay = false
    var showDescription = false
    var interactive = true

    @State private var isUpdating = false
    @State private var failure: String?

    private var subtitle: String {
        var parts: [String] = []
        if showDay { parts.append(item.startAt.formatted(Date.FormatStyle(timeZone: plan.zone).weekday(.abbreviated).month(.abbreviated).day())) }
        parts.append(plan.timeRange(item))
        if let assignment = item.assignment { parts.append(store.courseLabel(assignment.courseId)) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.headline).lineLimit(2)
                Text(subtitle).font(.subheadline).foregroundStyle(Color.subtleText).lineLimit(2)
                if showDescription, !item.description.isEmpty {
                    Text(item.description).font(.footnote).foregroundStyle(Color.subtleText).padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if interactive, showHelp, let assignment = item.assignment {
                Button("Get help") { router.newChat = NewChatRequest(courseId: assignment.courseId, itemId: assignment.assignmentId) }
                    .font(.subheadline.weight(.medium))
            }
        }
        .opacity(item.isWork ? 1 : 0.75)
        .alert("Couldn't update", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
    }

    @ViewBuilder
    private var leading: some View {
        if !item.isWork {
            Image(systemName: "cup.and.saucer")
                .foregroundStyle(Color.subtleText)
                .frame(width: 28, height: 28)
                .accessibilityHidden(true)
        } else if interactive {
            Button {
                toggle()
            } label: {
                CheckCircle(checked: item.isDone)
            }
            .buttonStyle(.plain)
            .disabled(isUpdating)
            .accessibilityLabel(item.isDone ? "Mark \(item.name) as not done" : "Mark \(item.name) as done")
        } else {
            CheckCircle(checked: item.isDone)
        }
    }

    private func toggle() {
        isUpdating = true
        Task {
            do { try await plans.setCompleted(plan, item: item, !item.isDone) } catch { failure = error.localizedDescription }
            isUpdating = false
        }
    }
}

/// The plan's blocks grouped under the day they fall on.
private struct PlanSchedule: View {
    let plan: WorkPlan
    var interactive = true

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ForEach(plan.days, id: \.day) { day in
                VStack(alignment: .leading, spacing: 8) {
                    Text(plan.dayTitle(day.day)).font(.title3.weight(.semibold))
                    RowGroup {
                        ForEach(day.items) { item in
                            PlanItemRow(plan: plan, item: item, showDescription: true, interactive: interactive)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - List

struct PlansListView: View {
    @Environment(PlanStore.self) private var plans
    @Environment(Router.self) private var router
    @State private var showCompleted = false

    var body: some View {
        let shown = plans.plans
            .filter { $0.isCompleted == showCompleted }
            .sorted { $0.createdAt > $1.createdAt }

        ScrollView {
            VStack(spacing: 16) {
                Picker("Plans", selection: $showCompleted) {
                    Text("Active").tag(false)
                    Text("Completed").tag(true)
                }
                .pickerStyle(.segmented)

                if shown.isEmpty {
                    Text(showCompleted ? "No completed plans yet." : "No active plans. Create one from Home.")
                        .foregroundStyle(Color.subtleText)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                }

                ForEach(shown) { plan in
                    Button { router.plansPath.append(.plan(plan.workPlanId)) } label: {
                        Card {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(plan.title).font(.headline)
                                        Text(plan.rangeText).font(.subheadline).foregroundStyle(Color.subtleText)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(.secondary)
                                }
                                SegmentedProgress(total: plan.workItems.count, done: plan.doneCount)
                                Text("\(plan.doneCount) of \(plan.workItems.count) done")
                                    .font(.footnote).foregroundStyle(Color.subtleText)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(20)
        }
        .refreshable { await plans.refresh() }
        .navigationTitle("Work plans")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Detail

struct PlanDetailView: View {
    @Environment(PlanStore.self) private var plans
    @Environment(Router.self) private var router
    let planId: String
    @State private var confirmDelete = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            if let plan = plans.plan(planId) {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow("Work plan")
                    Text(plan.title).font(.system(size: 32, weight: .bold)).padding(.top, 6)
                    Text("\(plan.rangeText) · \(plan.dayCount) days").foregroundStyle(Color.subtleText).padding(.top, 6)
                    SolidProgress(fraction: plan.fraction).padding(.top, 16)
                    Text("\(plan.doneCount) of \(plan.workItems.count) done").font(.footnote).foregroundStyle(Color.subtleText).padding(.top, 6)

                    if let preferences = plan.workPreferences, !preferences.isEmpty {
                        Text("Your notes for this plan").font(.title3.weight(.semibold)).padding(.top, 24)
                        Text(preferences)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
                            .padding(.top, 10)
                    }

                    Text("Schedule").font(.title3.weight(.semibold)).padding(.top, 24).padding(.bottom, 10)
                    if plan.items.isEmpty {
                        Text("This plan has no blocks.").foregroundStyle(Color.subtleText)
                    } else {
                        PlanSchedule(plan: plan)
                    }

                    if let errorMessage { ErrorBanner(message: errorMessage).padding(.top, 16) }

                    Button("Delete plan", role: .destructive) { confirmDelete = true }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 32)
                        .confirmationDialog("Delete this plan?", isPresented: $confirmDelete, titleVisibility: .visible) {
                            Button("Delete plan", role: .destructive) { delete(plan) }
                        } message: {
                            Text("Your assignments aren't affected.")
                        }
                }
                .padding(20)
            } else {
                Text("This plan isn't available any more.")
                    .foregroundStyle(Color.subtleText)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
            }
        }
        .refreshable { await plans.refresh() }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func delete(_ plan: WorkPlan) {
        Task {
            do {
                try await plans.delete(plan)
                if !router.plansPath.isEmpty { router.plansPath.removeLast() }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Wizard

private enum PlanStep: Hashable {
    case duration, preferences, preview
}

/// The most assignments one plan can cover, and the longest it can run (days after the start).
private enum PlanLimits {
    static let assignments = 20
    static let spanDays = 30
    static let notesLength = 500
}

@Observable
private final class PlanDraft {
    var selected: Set<String> = []
    var start = Calendar.current.startOfDay(for: .now)
    var end = Calendar.current.startOfDay(for: .now)
    var notes = ""
    var generated: WorkPlan?
    var isGenerating = false
    var errorMessage: String?

    /// Builds the plan on the server. Starting today means "from now", so no start time is sent.
    func make(using plans: PlanStore) async throws -> WorkPlan {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        let endOfLastDay = calendar.date(bySettingHour: 23, minute: 59, second: 0, of: end) ?? end
        return try await plans.create(
            assignmentIds: selected.sorted(),
            start: start > today ? start : nil,
            end: endOfLastDay,
            preferences: notes
        )
    }
}

struct PlanWizard: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft = PlanDraft()
    @State private var path: [PlanStep] = []

    var body: some View {
        NavigationStack(path: $path) {
            PlanPickItemsView(path: $path)
                .navigationDestination(for: PlanStep.self) { step in
                    switch step {
                    case .duration: PlanDurationView(path: $path)
                    case .preferences: PlanPreferencesView(path: $path)
                    case .preview: PlanPreviewView(close: { dismiss() })
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
        }
        .environment(draft)
        .interactiveDismissDisabled(draft.isGenerating)
    }
}

private struct PlanPickItemsView: View {
    @Environment(AppStore.self) private var store
    @Environment(PlanDraft.self) private var draft
    @Binding var path: [PlanStep]

    /// Only assignments can be planned: the server schedules them, and items with no course exist only on this device.
    private var plannable: [CalendarItem] {
        store.calendarItems.filter { $0.assignmentId != nil && !$0.completed }
    }

    private var hasUnplannable: Bool {
        store.calendarItems.contains { $0.assignmentId == nil && !$0.completed }
    }

    private var groups: [(courseId: String?, items: [CalendarItem])] {
        let grouped = Dictionary(grouping: plannable) { $0.courseId }
        return grouped.keys
            .sorted { store.courseLabel($0) < store.courseLabel($1) }
            .map { ($0, grouped[$0]!) }
    }

    private var isFull: Bool { draft.selected.count >= PlanLimits.assignments }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    StepBar(step: 1)
                    Text("What are you studying for?").font(.system(size: 32, weight: .bold)).padding(.top, 20)
                    Text("Pick the assignments this plan should cover.").foregroundStyle(Color.subtleText).padding(.top, 6)

                    if groups.isEmpty {
                        Text("You have no open assignments. Add some from the calendar first.")
                            .foregroundStyle(Color.subtleText).padding(.top, 24)
                    }

                    VStack(alignment: .leading, spacing: 20) {
                        ForEach(groups, id: \.courseId) { group in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(store.courseLabel(group.courseId).uppercased())
                                    .font(.caption.weight(.semibold)).foregroundStyle(Color.subtleText)
                                RowGroup {
                                    ForEach(group.items) { item in
                                        Button { toggle(item) } label: {
                                            HStack(spacing: 12) {
                                                CheckCircle(checked: draft.selected.contains(item.id))
                                                VStack(alignment: .leading, spacing: 2) {
                                                    Text(item.title).font(.headline)
                                                    Text(dueText(item)).font(.subheadline)
                                                        .foregroundStyle(isOverdue(item) ? Color.red : Color.subtleText)
                                                }
                                                Spacer()
                                            }
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(isFull && !draft.selected.contains(item.id))
                                    }
                                }
                            }
                        }
                    }
                    .padding(.top, 20)

                    if hasUnplannable {
                        Text("Items with no course can't be planned.")
                            .font(.footnote).foregroundStyle(Color.subtleText).padding(.top, 20)
                    }
                }
                .padding(.horizontal, 20)
            }

            VStack(spacing: 10) {
                Text(selectionText).font(.footnote).foregroundStyle(Color.subtleText)
                Button("Next") {
                    let chosen = plannable.filter { draft.selected.contains($0.id) }
                    let today = Calendar.current.startOfDay(for: .now)
                    let lastDue = max(chosen.map(\.day).max() ?? today, today)
                    draft.start = today
                    draft.end = min(lastDue, Calendar.current.date(byAdding: .day, value: PlanLimits.spanDays, to: today) ?? lastDue)
                    path.append(.duration)
                }
                .buttonStyle(.primary)
                .disabled(draft.selected.isEmpty)
            }
            .padding(20)
        }
        .navigationTitle("New work plan")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var selectionText: String {
        let count = draft.selected.count
        let base = count == 1 ? "1 assignment selected" : "\(count) assignments selected"
        return isFull ? "\(base) (the most one plan can cover)" : base
    }

    private func isOverdue(_ item: CalendarItem) -> Bool { item.day < Calendar.current.startOfDay(for: .now) }

    private func dueText(_ item: CalendarItem) -> String {
        isOverdue(item) ? "Overdue · was due \(item.day.dayTitle)" : "Due \(item.day.dayTitle)"
    }

    private func toggle(_ item: CalendarItem) {
        if draft.selected.contains(item.id) { draft.selected.remove(item.id) } else { draft.selected.insert(item.id) }
    }
}

private struct PlanDurationView: View {
    @Environment(AppStore.self) private var store
    @Environment(PlanDraft.self) private var draft
    @Binding var path: [PlanStep]

    private var chosen: [CalendarItem] { store.calendarItems.filter { draft.selected.contains($0.id) } }

    private var dayCount: Int {
        let calendar = Calendar.current
        return max((calendar.dateComponents([.day], from: draft.start, to: draft.end).day ?? 0) + 1, 1)
    }

    private var today: Date { Calendar.current.startOfDay(for: .now) }

    private func lastEnd(from start: Date) -> Date {
        Calendar.current.date(byAdding: .day, value: PlanLimits.spanDays, to: start) ?? start
    }

    var body: some View {
        @Bindable var draft = draft
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    StepBar(step: 2)
                    Text("How long is this plan?").font(.system(size: 32, weight: .bold)).padding(.top, 20)
                    Text("It ends on the last due date you picked unless you change it. A plan can cover up to 31 days.")
                        .foregroundStyle(Color.subtleText).padding(.top, 6)

                    VStack(alignment: .leading, spacing: 16) {
                        LabeledField(label: "Start date") {
                            DateRow(selection: $draft.start, range: today...Calendar.current.date(byAdding: .day, value: 365, to: today)!)
                        }
                        LabeledField(label: "End date") {
                            DateRow(selection: $draft.end, range: draft.start...lastEnd(from: draft.start))
                        }
                    }
                    .padding(.top, 20)

                    Card(fill: .brandSoft) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(dayCount == 1 ? "1 day" : "\(dayCount) days").font(.title2.weight(.bold))
                            Text("Covers \(ListFormatter.localizedString(byJoining: chosen.map(\.title)))")
                                .font(.footnote).foregroundStyle(Color.subtleText)
                        }
                    }
                    .padding(.top, 20)
                }
                .padding(.horizontal, 20)
            }

            Button("Next") { path.append(.preferences) }
                .buttonStyle(.primary)
                .padding(20)
        }
        .navigationTitle("New work plan")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: draft.start) { _, start in
            draft.end = min(max(draft.end, start), lastEnd(from: start))
        }
    }
}

private struct DateRow: View {
    @Binding var selection: Date
    let range: ClosedRange<Date>

    var body: some View {
        HStack {
            DatePicker("", selection: $selection, in: range, displayedComponents: .date)
                .labelsHidden()
            Spacer()
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 52)
        .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct PlanPreferencesView: View {
    @Environment(AppStore.self) private var store
    @Environment(PlanStore.self) private var plans
    @Environment(PlanDraft.self) private var draft
    @Binding var path: [PlanStep]

    private var savedPreferences: String {
        (store.user?.studyPreferences ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        @Bindable var draft = draft
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    StepBar(step: 3)
                    Text("Anything for this plan?").font(.system(size: 32, weight: .bold)).padding(.top, 4)
                    Text("Optional. Say what you want from this plan, like \"nothing after 9pm\" or \"keep Sunday free\".")
                        .foregroundStyle(Color.subtleText)

                    LabeledField(label: "Notes for this plan") {
                        TextField("For example: nothing after 9pm this week", text: $draft.notes, axis: .vertical)
                            .lineLimit(3...8)
                            .textFieldStyle(.minerva)
                            .onChange(of: draft.notes) { _, text in
                                if text.count > PlanLimits.notesLength { draft.notes = String(text.prefix(PlanLimits.notesLength)) }
                            }
                        Text("\(draft.notes.count)/\(PlanLimits.notesLength)")
                            .font(.footnote).foregroundStyle(Color.subtleText)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }

                    if !savedPreferences.isEmpty {
                        Card(fill: .brandSoft) {
                            VStack(alignment: .leading, spacing: 6) {
                                Eyebrow("Your study preferences")
                                Text(savedPreferences).font(.subheadline)
                                Text("These are used too. If they conflict with your notes above, your notes win. Change them from your profile.")
                                    .font(.footnote).foregroundStyle(Color.subtleText)
                            }
                        }
                    }

                    if let message = draft.errorMessage { ErrorBanner(message: message) }
                }
                .padding(.horizontal, 20)
            }
            .scrollDismissesKeyboard(.interactively)

            Button("Generate plan") { generate() }
                .buttonStyle(.primary)
                .disabled(draft.isGenerating)
                .padding(20)
        }
        .navigationTitle("New work plan")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(draft.isGenerating)
        .overlay { if draft.isGenerating { GeneratingOverlay() } }
    }

    private func generate() {
        draft.errorMessage = nil
        draft.isGenerating = true
        Task {
            do {
                draft.generated = try await draft.make(using: plans)
                path.append(.preview)
            } catch {
                draft.errorMessage = error.localizedDescription
            }
            draft.isGenerating = false
        }
    }
}

/// Covers the screen while the plan is being made, which can take up to half a minute.
private struct GeneratingOverlay: View {
    var body: some View {
        ZStack {
            Color.black.opacity(0.3).ignoresSafeArea()
            Card {
                VStack(spacing: 12) {
                    ProgressView().controlSize(.large)
                    Text("Building your plan…").font(.headline)
                    Text("This can take up to 30 seconds.").font(.footnote).foregroundStyle(Color.subtleText)
                }
                .frame(maxWidth: .infinity)
            }
            .padding(40)
        }
        .transition(.opacity)
    }
}

/// The plan has already been saved by the time this shows. "Regenerate" swaps it for a freshly made one.
private struct PlanPreviewView: View {
    @Environment(PlanStore.self) private var plans
    @Environment(Router.self) private var router
    @Environment(PlanDraft.self) private var draft
    let close: () -> Void

    var body: some View {
        ScrollView {
            if let plan = draft.generated {
                VStack(alignment: .leading, spacing: 0) {
                    Card(fill: .brandSoft) {
                        VStack(alignment: .leading, spacing: 4) {
                            Eyebrow("New plan")
                            Text(plan.rangeText).font(.system(size: 30, weight: .bold))
                            Text("\(plan.dayCount) days · \(plan.workItems.count) sessions").foregroundStyle(Color.subtleText)
                        }
                    }

                    Button {
                        regenerate()
                    } label: {
                        if draft.isGenerating { ProgressView() } else { Text("Regenerate") }
                    }
                    .buttonStyle(.secondary)
                    .disabled(draft.isGenerating)
                    .padding(.top, 12)

                    if let preferences = plan.workPreferences, !preferences.isEmpty {
                        Text("Your notes").font(.title3.weight(.semibold)).padding(.top, 24)
                        Text(preferences).foregroundStyle(Color.subtleText).padding(.top, 6)
                    }

                    Text("Schedule").font(.title3.weight(.semibold)).padding(.top, 24).padding(.bottom, 10)
                    PlanSchedule(plan: plan, interactive: false)

                    if let message = draft.errorMessage { ErrorBanner(message: message).padding(.top, 16) }
                }
                .padding(20)
            }
        }
        .navigationTitle("Your plan")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(draft.isGenerating)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    if let plan = draft.generated {
                        close()
                        router.openPlan(plan.workPlanId)
                    }
                }
                .fontWeight(.semibold)
                .disabled(draft.generated == nil || draft.isGenerating)
            }
        }
        .overlay { if draft.isGenerating { GeneratingOverlay() } }
    }

    private func regenerate() {
        guard let old = draft.generated else { return }
        draft.errorMessage = nil
        draft.isGenerating = true
        Task {
            do {
                // The old plan is only removed once the new one exists, so a failure leaves it in place.
                let fresh = try await draft.make(using: plans)
                try? await plans.delete(old)
                draft.generated = fresh
            } catch {
                draft.errorMessage = error.localizedDescription
            }
            draft.isGenerating = false
        }
    }
}
