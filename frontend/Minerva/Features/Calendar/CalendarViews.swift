//
//  CalendarViews.swift
//  Minerva
//

import SwiftUI

struct CalendarView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var month = Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: .now))!
    @State private var selected = Calendar.current.startOfDay(for: .now)
    @State private var showCanvasImport = false

    private var calendar: Calendar { .current }

    private var itemsByDay: [Date: [CalendarItem]] {
        Dictionary(grouping: store.calendarItems, by: \.day)
    }

    /// The month's days, padded with `nil` so the first one lands under the right weekday.
    private var cells: [Date?] {
        let range = calendar.range(of: .day, in: .month, for: month) ?? 1..<31
        let leading = calendar.component(.weekday, from: month) - calendar.firstWeekday
        let padding = (leading + 7) % 7
        let days = range.compactMap { calendar.date(byAdding: .day, value: $0 - 1, to: month) }
        return Array(repeating: nil, count: padding) + days
    }

    private var weekdaySymbols: [String] {
        let symbols = calendar.veryShortStandaloneWeekdaySymbols
        let shift = calendar.firstWeekday - 1
        return Array(symbols[shift...] + symbols[..<shift])
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Button("Create work plan") { router.showPlanWizard = true }
                    .buttonStyle(.soft)

                HStack {
                    Text(month.formatted(.dateTime.month(.wide).year())).font(.title2.weight(.bold))
                    Spacer()
                    HStack(spacing: 20) {
                        Button { shiftMonth(-1) } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel("Previous month")
                        Button { shiftMonth(1) } label: { Image(systemName: "chevron.right") }
                            .accessibilityLabel("Next month")
                    }
                    .font(.headline)
                }

                VStack(spacing: 6) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: 0) {
                        ForEach(Array(weekdaySymbols.enumerated()), id: \.offset) { _, symbol in
                            Text(symbol).font(.caption.weight(.semibold)).foregroundStyle(Color.subtleText).frame(height: 24)
                        }
                        ForEach(Array(cells.enumerated()), id: \.offset) { _, date in
                            if let date {
                                DayCell(date: date, isSelected: calendar.isDate(date, inSameDayAs: selected), hasItems: itemsByDay[date] != nil) {
                                    selected = date
                                }
                            } else {
                                Color.clear.frame(height: 48)
                            }
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(selected.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()).uppercased())
                        .font(.caption.weight(.semibold)).foregroundStyle(Color.subtleText)

                    if let items = itemsByDay[selected] {
                        RowGroup {
                            ForEach(items) { item in
                                Button { router.itemDetail = ItemRef(id: item.id) } label: { DayItemRow(item: item) }
                                    .buttonStyle(.plain)
                            }
                        }
                    } else {
                        Text("Nothing on this day.").foregroundStyle(Color.subtleText).padding(.vertical, 8)
                    }
                }
            }
            .padding(20)
        }
        .navigationTitle("Calendar")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { router.addItem = AddItemRequest(day: selected) } label: { Label("Add item", systemImage: "plus") }
                    Button { showCanvasImport = true } label: { Label("Add from Canvas or link", systemImage: "square.and.arrow.down") }
                } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Add")
            }
        }
        .sheet(isPresented: $showCanvasImport) { CanvasImportSheet() }
    }

    private func shiftMonth(_ delta: Int) {
        guard let next = calendar.date(byAdding: .month, value: delta, to: month) else { return }
        month = next
        if !calendar.isDate(selected, equalTo: next, toGranularity: .month) {
            selected = next
        }
    }
}

private struct DayCell: View {
    let date: Date
    let isSelected: Bool
    let hasItems: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Text(date.formatted(.dateTime.day()))
                    .font(.system(size: 17, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Color.onBrand : Calendar.current.isDateInToday(date) ? Color.brand : Color.primary)
                    .frame(width: 36, height: 36)
                    .background(isSelected ? Color.brand : Color.clear, in: Circle())
                Circle()
                    .fill(hasItems ? (isSelected ? Color.brand : Color.brand) : Color.clear)
                    .frame(width: 5, height: 5)
            }
            .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.plain)
    }
}

private struct DayItemRow: View {
    @Environment(AppStore.self) private var store
    let item: CalendarItem

    var body: some View {
        HStack(spacing: 12) {
            if item.courseId != nil {
                Badge(text: store.initials(item.courseId), size: 40)
            } else {
                Badge(text: String(item.title.prefix(2)).uppercased(), size: 40, tint: .primary, fill: .chipFill)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.headline).strikethrough(item.completed).lineLimit(1)
                Text(subtitle).font(.subheadline).foregroundStyle(Color.subtleText).lineLimit(1)
                Text(item.fromCanvas ? "From Canvas" : "Added by you").font(.caption).foregroundStyle(Color.subtleText)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").foregroundStyle(.secondary)
        }
    }

    private var subtitle: String {
        [item.courseId == nil ? "No course" : store.courseLabel(item.courseId), item.timeText].compactMap { $0 }.joined(separator: " · ")
    }
}

// MARK: - Add item

struct AddItemSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let initialDay: Date
    @State private var title = ""
    @State private var day: Date
    @State private var hasTime = false
    @State private var time = Calendar.current.date(bySettingHour: 23, minute: 59, second: 0, of: .now)!
    @State private var details = ""
    @State private var courseId: String?
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(initialDay: Date) {
        self.initialDay = initialDay
        _day = State(initialValue: initialDay)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    LabeledField(label: "Title") {
                        TextField("e.g. Study group", text: $title).textFieldStyle(.minerva)
                    }
                    LabeledField(label: "Date") {
                        HStack {
                            DatePicker("", selection: $day, displayedComponents: .date).labelsHidden()
                            Spacer()
                        }
                        .padding(.horizontal, 12).frame(minHeight: 52)
                        .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
                    }
                    LabeledField(label: "Time") {
                        TimeRow(hasTime: $hasTime, time: $time)
                    }
                    LabeledField(label: "Description") {
                        TextField("Add details", text: $details, axis: .vertical)
                            .lineLimit(3...6)
                            .padding(16)
                            .frame(minHeight: 96, alignment: .topLeading)
                            .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
                    }
                    LabeledField(label: "Course") {
                        CoursePicker(selection: $courseId)
                    }
                    if let errorMessage { ErrorBanner(message: errorMessage) }
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("New item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() } else {
                        Button("Save", action: save).fontWeight(.semibold)
                            .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isSaving)
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await store.addItem(
                    title: title.trimmingCharacters(in: .whitespaces),
                    description: details.trimmingCharacters(in: .whitespacesAndNewlines),
                    day: day,
                    time: hasTime ? time : nil,
                    courseId: courseId
                )
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSaving = false
            }
        }
    }
}

struct TimeRow: View {
    @Binding var hasTime: Bool
    @Binding var time: Date

    var body: some View {
        HStack {
            if hasTime {
                DatePicker("", selection: $time, displayedComponents: .hourAndMinute).labelsHidden()
                Spacer()
                Button("Remove") { hasTime = false }.font(.subheadline)
            } else {
                Button { hasTime = true } label: {
                    HStack {
                        Text("None").foregroundStyle(Color.subtleText)
                        Spacer()
                        Image(systemName: "chevron.down").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, hasTime ? 12 : 16)
        .frame(minHeight: 52)
        .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
    }
}

/// A dropdown over the student's courses, with None first.
struct CoursePicker: View {
    @Environment(AppStore.self) private var store
    @Binding var selection: String?
    var allowNone = true
    var noneLabel = "None"

    var body: some View {
        Menu {
            if allowNone { Button(noneLabel) { selection = nil } }
            ForEach(store.pickableCourses) { course in
                Button(courseTitle(course.courseId)) { selection = course.courseId }
            }
        } label: {
            DropdownRow {
                Text(selection == nil ? noneLabel : courseTitle(selection))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
            }
        }
        .buttonStyle(.plain)
    }

    private func courseTitle(_ id: String?) -> String {
        guard let code = store.code(id) else { return store.displayName(id) }
        return "\(code) · \(store.displayName(id))"
    }
}

// MARK: - Item detail

struct ItemDetailSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    let itemId: String
    @State private var isEditing = false
    @State private var title = ""
    @State private var day = Date.now
    @State private var hasTime = false
    @State private var time = Date.now
    @State private var details = ""
    @State private var isWorking = false
    @State private var confirmDelete = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            if let item = store.item(itemId) {
                content(item)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(isEditing ? "Cancel" : "Close") { isEditing ? (isEditing = false) : dismiss() }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            if isWorking { ProgressView() } else if isEditing {
                                Button("Save") { save(item) }.fontWeight(.semibold)
                                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                            } else {
                                Button("Edit") { beginEditing(item) }
                            }
                        }
                    }
                    .navigationBarTitleDisplayMode(.inline)
            } else {
                ProgressView().onAppear { dismiss() }
            }
        }
        .presentationDragIndicator(.visible)
        .confirmationDialog("Delete this item?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete item", role: .destructive) { delete() }
        }
    }

    @ViewBuilder
    private func content(_ item: CalendarItem) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if isEditing {
                    editor
                } else {
                    Eyebrow(item.courseId == nil ? "No course" : store.courseLabel(item.courseId))
                    Text(item.title).font(.system(size: 32, weight: .bold)).padding(.top, 6)
                    FlowLayout {
                        Chip(text: "Due \(item.day.dayTitle)\(item.timeText.map { " · \($0)" } ?? "")")
                        if item.fromCanvas { Chip(text: "From Canvas") }
                        if item.completed { Chip(text: "Done", tint: .brand, fill: .brandSoft) }
                    }
                    .padding(.top, 12)

                    HStack(spacing: 12) {
                        Button("Get help with this") { router.startChat(courseId: item.courseId, itemId: item.id) }
                            .buttonStyle(.primary)
                        Button("Delete") { confirmDelete = true }
                            .buttonStyle(OutlineButtonStyle())
                            .fixedSize()
                    }
                    .padding(.top, 16)

                    if item.courseId != nil {
                        LabeledField(label: "Course") {
                            HStack {
                                Text(store.displayName(item.courseId))
                                Spacer()
                            }
                            .padding(.horizontal, 16).frame(minHeight: 52)
                            .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
                        }
                        .padding(.top, 20)
                    }

                    if !item.description.isEmpty {
                        LabeledField(label: "Description") {
                            Text(item.description)
                        }
                        .padding(.top, 20)
                    }
                }

                if let errorMessage { ErrorBanner(message: errorMessage).padding(.top, 16) }

                if !isEditing {
                    Button(item.completed ? "Mark as not done" : "Mark as done") { toggleDone(item) }
                        .font(.subheadline.weight(.medium))
                        .padding(.top, 24)
                }
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .disabled(isWorking)
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 20) {
            LabeledField(label: "Title") { TextField("Title", text: $title).textFieldStyle(.minerva) }
            LabeledField(label: "Date") {
                HStack {
                    DatePicker("", selection: $day, displayedComponents: .date).labelsHidden()
                    Spacer()
                }
                .padding(.horizontal, 12).frame(minHeight: 52)
                .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
            }
            LabeledField(label: "Time") { TimeRow(hasTime: $hasTime, time: $time) }
            LabeledField(label: "Description") {
                TextField("Add details", text: $details, axis: .vertical)
                    .lineLimit(3...8)
                    .padding(16)
                    .frame(minHeight: 96, alignment: .topLeading)
                    .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    private func beginEditing(_ item: CalendarItem) {
        title = item.title
        day = item.day
        hasTime = item.hasTime
        time = item.hasTime ? item.due : (Calendar.current.date(bySettingHour: 23, minute: 59, second: 0, of: .now) ?? .now)
        details = item.description
        errorMessage = nil
        isEditing = true
    }

    private func save(_ item: CalendarItem) {
        run { try await store.updateItem(item, title: title.trimmingCharacters(in: .whitespaces), description: details.trimmingCharacters(in: .whitespacesAndNewlines), day: day, time: hasTime ? time : nil) }
            onSuccess: { isEditing = false }
    }

    private func toggleDone(_ item: CalendarItem) {
        run { try await store.setCompleted(item, !item.completed) } onSuccess: {}
    }

    private func delete() {
        guard let item = store.item(itemId) else { return }
        run { try await store.delete(item) } onSuccess: { dismiss() }
    }

    private func run(_ work: @escaping () async throws -> Void, onSuccess: @escaping () -> Void) {
        isWorking = true
        errorMessage = nil
        Task {
            do {
                try await work()
                onSuccess()
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }
}
