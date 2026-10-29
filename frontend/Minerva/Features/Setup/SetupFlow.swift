//
//  SetupFlow.swift
//  Minerva
//

import SwiftUI

enum SetupStep: Hashable {
    case canvas
    case review
    case prefs(Int)
    case prefsReview
}

/// State shared by the setup steps.
@Observable
final class SetupModel {
    var events: [CanvasEvent] = []
    /// The course chosen for each event, by event id. `nil` means None.
    var choices: [String: String?] = [:]
    var matchFailed = false
    var prefs = StudyPrefs()
    /// Set when importing from the calendar after setup: no step bar, and finishing closes the sheet.
    var onFinish: (() -> Void)?
    var isStandalone: Bool { onFinish != nil }
}

struct SetupFlow: View {
    @Environment(AppStore.self) private var store
    @State private var path: [SetupStep] = []
    @State private var model = SetupModel()

    var body: some View {
        NavigationStack(path: $path) {
            SetupCoursesView(path: $path)
                .navigationDestination(for: SetupStep.self) { step in
                    switch step {
                    case .canvas: SetupCanvasView(path: $path)
                    case .review: SetupReviewView(path: $path)
                    case .prefs(let index): SetupPreferencesView(index: index, path: $path)
                    case .prefsReview: SetupPreferencesReviewView()
                    }
                }
        }
        .environment(model)
    }
}

// MARK: - Step 1: courses

struct SetupCoursesView: View {
    @Environment(AppStore.self) private var store
    @Binding var path: [SetupStep]
    @State private var showAddCourse = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    StepBar(step: 1)
                    Eyebrow("Step 1 of 3").padding(.top, 20)
                    Text("Add your courses").font(.system(size: 32, weight: .bold)).padding(.top, 6)
                    Text("Upload a syllabus and materials so help matches each class.")
                        .foregroundStyle(Color.subtleText)
                        .padding(.top, 6)

                    VStack(spacing: 16) {
                        ForEach(store.pickableCourses) { course in
                            SetupCourseCard(course: course)
                        }
                        Button("Add course") { showAddCourse = true }
                            .buttonStyle(.soft)
                    }
                    .padding(.top, 20)
                }
                .padding(.horizontal, 20)
            }

            Button("Continue") { path.append(.canvas) }
                .buttonStyle(.primary)
                .padding(20)
        }
        .navigationTitle("Setup")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Skip") { path.append(.canvas) } }
        }
        .sheet(isPresented: $showAddCourse) {
            AddCourseSheet()
        }
    }
}

private struct SetupCourseCard: View {
    @Environment(AppStore.self) private var store
    let course: Course

    var body: some View {
        let jobs = store.jobs(for: course.courseId)
        Card {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Badge(text: store.initials(course.courseId))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.displayName(course.courseId)).font(.headline)
                        Text([store.code(course.courseId), store.term(course.courseId)].compactMap { $0 }.joined(separator: " · "))
                            .font(.subheadline)
                            .foregroundStyle(Color.subtleText)
                    }
                }
                if !jobs.isEmpty {
                    Divider()
                    ForEach(jobs) { job in UploadRow(job: job) }
                }
            }
        }
    }
}

struct UploadRow: View {
    @Environment(AppStore.self) private var store
    let job: UploadJob

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(job.file.filename).font(.subheadline.weight(.medium)).lineLimit(1)
                if case .failed(let message) = job.state {
                    Text(message).font(.footnote).foregroundStyle(Color.subtleText).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if job.isFailed {
                Button("Retry") { store.retry(job) }
                    .font(.subheadline.weight(.medium))
            } else {
                Chip(text: job.statusText, tint: job.isReady ? .brand : .primary, fill: job.isReady ? .brandSoft : .chipFill)
            }
        }
    }
}

// MARK: - Add course

struct AddCourseSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var code = ""
    @State private var term = ""
    @State private var syllabus: PickedFile?
    @State private var materials: [PickedFile] = []
    @State private var picking: Picker?
    @State private var isSaving = false
    @State private var errorMessage: String?

    enum Picker: Identifiable {
        case syllabus, materials
        var id: Self { self }
    }

    private var canSave: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !isSaving }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    LabeledField(label: "Course name") {
                        TextField("e.g. Ubiquitous Development", text: $name).textFieldStyle(.minerva)
                    }
                    LabeledField(label: "Course code") {
                        TextField("e.g. COSC 4355", text: $code).textFieldStyle(.minerva).textInputAutocapitalization(.characters)
                    }
                    LabeledField(label: "Term") {
                        TextField("e.g. Fall 2026", text: $term).textFieldStyle(.minerva)
                    }
                    LabeledField(label: "Syllabus") {
                        DropZone(title: "Choose PDF", files: syllabus.map { [$0] } ?? []) { picking = .syllabus }
                    }
                    LabeledField(label: "Textbooks and materials") {
                        DropZone(title: "Choose PDFs", files: materials) { picking = .materials }
                    }
                    if let errorMessage { ErrorBanner(message: errorMessage) }
                }
                .padding(20)
            }
            .navigationTitle("Add course")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() } else { Button("Save", action: save).fontWeight(.semibold).disabled(!canSave) }
                }
            }
            .fileImporter(
                isPresented: Binding(get: { picking != nil }, set: { if !$0 { picking = nil } }),
                allowedContentTypes: PickedFile.pdfOnly,
                allowsMultipleSelection: picking == .materials
            ) { result in
                handle(result)
            }
        }
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isSaving)
    }

    private func handle(_ result: Result<[URL], Error>) {
        let target = picking
        picking = nil
        do {
            let urls = try result.get()
            let files = try urls.map { try PickedFile.make(from: $0, allowImages: false) }
            if target == .syllabus { syllabus = files.first } else { materials.append(contentsOf: files) }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await store.createCourse(
                    name: name.trimmingCharacters(in: .whitespaces),
                    code: code.trimmingCharacters(in: .whitespaces),
                    term: term.trimmingCharacters(in: .whitespaces),
                    syllabus: syllabus,
                    materials: materials
                )
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSaving = false
            }
        }
    }
}

private struct DropZone: View {
    let title: String
    let files: [PickedFile]
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                if files.isEmpty {
                    Text(title).font(.headline).foregroundStyle(Color.brand)
                    Text("PDF files").font(.footnote).foregroundStyle(Color.subtleText)
                } else {
                    ForEach(files) { file in
                        Text(file.filename).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
                    }
                    Text("Tap to add more").font(.footnote).foregroundStyle(Color.brand)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 84)
            .padding(.vertical, 8)
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(Color.track, style: StrokeStyle(lineWidth: 1.5, dash: [6, 5]))
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Step 2: Canvas

struct SetupCanvasView: View {
    @Environment(AppStore.self) private var store
    @Environment(SetupModel.self) private var model
    @Binding var path: [SetupStep]
    @State private var query = ""
    @State private var results: [CanvasSchool] = []
    @State private var isSearching = false
    @State private var searchFailed = false
    @State private var school: CanvasSchool?
    @State private var showLink = false
    @State private var link = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !model.isStandalone {
                    StepBar(step: 2)
                    Eyebrow("Step 2 of 3").padding(.top, 20)
                }
                Text("Link your Canvas calendar").font(.system(size: 32, weight: .bold)).padding(.top, 6)
                Text("Sign in to your school's Canvas and Minerva imports your due dates.")
                    .foregroundStyle(Color.subtleText)
                    .padding(.top, 6)

                HStack {
                    TextField("Search for your school", text: $query)
                        .autocorrectionDisabled()
                    if isSearching {
                        ProgressView().controlSize(.small)
                    } else if !query.isEmpty {
                        Button("Clear") { query = "" }
                            .font(.subheadline)
                            .foregroundStyle(Color.subtleText)
                    }
                }
                .padding(.horizontal, 16)
                .frame(height: 52)
                .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
                .padding(.top, 20)

                if !results.isEmpty {
                    RowGroup {
                        ForEach(results) { result in
                            Button { school = result } label: {
                                HStack(spacing: 12) {
                                    Badge(text: result.initials)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(result.name).font(.headline).multilineTextAlignment(.leading)
                                        Text(result.host).font(.subheadline).foregroundStyle(Color.subtleText)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(.secondary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 16)
                } else if searchFailed {
                    ErrorBanner(message: "Couldn't search for schools right now. Check your connection, or paste your calendar link below.")
                        .padding(.top, 16)
                } else if trimmedQuery.count >= 2, !isSearching {
                    Text("No schools found. Try a different spelling.")
                        .font(.subheadline).foregroundStyle(Color.subtleText).padding(.top, 16)
                }

                if isLoading {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Importing your calendar…").foregroundStyle(Color.subtleText)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 24)
                }
                if let errorMessage { ErrorBanner(message: errorMessage).padding(.top, 16) }

                Button("Paste a calendar link instead") { showLink = true }
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 24)
            }
            .padding(.horizontal, 20)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(model.isStandalone ? "Import from Canvas" : "Setup")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.isStandalone {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.onFinish?() } }
            } else {
                ToolbarItem(placement: .confirmationAction) { Button("Skip") { path.append(.prefs(0)) } }
            }
        }
        .task(id: query) { await search() }
        .fullScreenCover(item: $school) { school in
            CanvasLoginSheet(school: school) { url in importEvents(from: url) }
        }
        .alert("Paste a calendar link", isPresented: $showLink) {
            TextField("https://…", text: $link)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
            Button("Import") {
                if let url = CanvasFeed.normalize(link) {
                    importEvents(from: url)
                } else {
                    errorMessage = "That doesn't look like a calendar link. It should start with https:// or webcal://."
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("In Canvas, open Calendar and choose Calendar Feed to copy it.")
        }
        .disabled(isLoading)
    }

    /// Looks up schools as the student types, after a short pause.
    private func search() async {
        let term = trimmedQuery
        guard term.count >= 2 else {
            results = []
            searchFailed = false
            isSearching = false
            return
        }
        isSearching = true
        try? await Task.sleep(for: .milliseconds(350))
        guard !Task.isCancelled else { return }
        do {
            let found = try await CanvasDirectory.search(term)
            guard !Task.isCancelled else { return }
            results = found
            searchFailed = false
        } catch {
            guard !Task.isCancelled else { return }
            results = []
            searchFailed = true
        }
        isSearching = false
    }

    /// Reads the calendar feed, then matches each event's course against the student's Minerva courses.
    private func importEvents(from url: URL) {
        isLoading = true
        errorMessage = nil
        Task {
            defer { isLoading = false }
            do {
                // Events already imported on an earlier run are skipped.
                let calendar = Calendar.current
                let events = try await CanvasFeed.load(url).filter { event in
                    !store.calendarItems.contains { $0.fromCanvas && $0.title == event.title && calendar.isDate($0.due, inSameDayAs: event.due) }
                }
                guard !events.isEmpty else {
                    errorMessage = "We found your calendar, but it has no new upcoming events."
                    return
                }
                model.events = events
                do {
                    let matches = try await store.matchCourses(names: events.map(\.courseName))
                    model.choices = Dictionary(uniqueKeysWithValues: events.map { ($0.id, matches[$0.courseName] ?? nil) })
                    model.matchFailed = false
                } catch {
                    model.choices = Dictionary(uniqueKeysWithValues: events.map { ($0.id, nil) })
                    model.matchFailed = true
                }
                path.append(.review)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Step 2b: review events

struct SetupReviewView: View {
    @Environment(AppStore.self) private var store
    @Environment(SetupModel.self) private var model
    @Binding var path: [SetupStep]
    @State private var isImporting = false
    @State private var errorMessage: String?

    private var groups: [(day: Date, events: [CanvasEvent])] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: model.events) { calendar.startOfDay(for: $0.due) }
        return grouped.keys.sorted().map { ($0, grouped[$0]!.sorted { $0.due < $1.due }) }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if !model.isStandalone {
                        StepBar(step: 2)
                        Eyebrow("Step 2 of 3").padding(.top, 20)
                    }
                    Text("Check your courses").font(.system(size: 32, weight: .bold)).padding(.top, 6)
                    Text("Each event is matched to a course. Change any that look wrong.")
                        .foregroundStyle(Color.subtleText)
                        .padding(.top, 6)

                    if model.matchFailed {
                        ErrorBanner(message: "We couldn't match your courses automatically. Pick a course for each event.")
                            .padding(.top, 12)
                    } else if store.pickableCourses.isEmpty {
                        Text("You haven't added any courses yet, so these events won't be linked to one.")
                            .font(.footnote).foregroundStyle(Color.subtleText).padding(.top, 12)
                    }

                    VStack(alignment: .leading, spacing: 20) {
                        ForEach(groups, id: \.day) { group in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(group.day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()).uppercased())
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Color.subtleText)
                                RowGroup {
                                    ForEach(group.events) { event in
                                        EventChoiceRow(event: event)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.top, 20)

                    if let errorMessage { ErrorBanner(message: errorMessage).padding(.top, 16) }
                }
                .padding(.horizontal, 20)
            }

            Button {
                importAll()
            } label: {
                if isImporting { ProgressView().tint(Color.onBrand) } else { Text("Continue") }
            }
            .buttonStyle(.primary)
            .disabled(isImporting)
            .padding(20)
        }
        .navigationTitle(model.isStandalone ? "Review events" : "Setup")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func importAll() {
        isImporting = true
        errorMessage = nil
        Task {
            // Imported events are removed as they succeed, so retrying after a failure only redoes the rest.
            for event in model.events {
                do {
                    try await store.addItem(
                        title: event.title,
                        description: event.detail,
                        day: event.due,
                        time: event.hasTime ? event.due : nil,
                        courseId: model.choices[event.id] ?? nil,
                        fromCanvas: true
                    )
                    model.events.removeAll { $0.id == event.id }
                } catch {
                    continue
                }
            }
            isImporting = false
            if model.events.isEmpty {
                if let finish = model.onFinish { finish() } else { path.append(.prefs(0)) }
            } else {
                errorMessage = "\(model.events.count) events couldn't be imported. Tap Continue to try those again."
            }
        }
    }
}

private struct EventChoiceRow: View {
    @Environment(AppStore.self) private var store
    @Environment(SetupModel.self) private var model
    let event: CanvasEvent

    var body: some View {
        let selected = model.choices[event.id] ?? nil
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).font(.headline)
                Text(event.timeNote ?? (event.hasTime ? "Due \(event.due.formatted(date: .omitted, time: .shortened))" : "No time"))
                    .font(.subheadline).foregroundStyle(Color.subtleText)
            }
            Spacer(minLength: 8)
            Menu {
                Button("None") { model.choices[event.id] = .some(nil) }
                ForEach(store.pickableCourses) { course in
                    Button(store.courseLabel(course.courseId)) { model.choices[event.id] = .some(course.courseId) }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(selected.map { store.courseLabel($0) } ?? "None")
                    Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(selected == nil ? Color.primary : Color.brand)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(selected == nil ? Color.chipFill : Color.brandSoft, in: Capsule())
            }
        }
    }
}

// MARK: - Step 3: preferences

private struct PrefQuestion {
    let title: String
    let placeholder: String
    let picks: [String]
    let keyPath: WritableKeyPath<StudyPrefs, String>
    let summaryTitle: String

    static let all = [
        PrefQuestion(title: "How do you like to take breaks?", placeholder: "e.g. 10 minutes every 45 minutes",
                     picks: ["Every 45 min", "Pomodoro", "Few long breaks", "No breaks"], keyPath: \.breaks, summaryTitle: "Breaks"),
        PrefQuestion(title: "How do you like things explained?", placeholder: "e.g. Short examples first, then the theory",
                     picks: ["Examples first", "Step by step", "Big picture first", "Diagrams"], keyPath: \.explanations, summaryTitle: "Explanations"),
        PrefQuestion(title: "Do you want practice problems?", placeholder: "e.g. Yes, 3–5 per topic",
                     picks: ["Yes, a few", "Lots of them", "Only before exams", "No thanks"], keyPath: \.practice, summaryTitle: "Practice problems"),
        PrefQuestion(title: "When do you usually study?", placeholder: "e.g. Weeknights after 6 PM",
                     picks: ["Mornings", "Afternoons", "Weeknights", "Weekends"], keyPath: \.times, summaryTitle: "Study times"),
        PrefQuestion(title: "Anything else we should know?", placeholder: "e.g. Long paragraphs are hard for me to follow",
                     picks: ["Keep it short", "Go slowly", "Use plain language"], keyPath: \.other, summaryTitle: "Other"),
    ]
}

struct SetupPreferencesView: View {
    @Environment(AppStore.self) private var store
    @Environment(SetupModel.self) private var model
    let index: Int
    @Binding var path: [SetupStep]
    @State private var isFinishing = false

    private var question: PrefQuestion { PrefQuestion.all[index] }
    private var isLast: Bool { index == PrefQuestion.all.count - 1 }

    var body: some View {
        @Bindable var model = model
        let text = Binding(
            get: { model.prefs[keyPath: question.keyPath] },
            set: { model.prefs[keyPath: question.keyPath] = $0 }
        )
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    StepBar(step: 3)
                    Eyebrow("Step 3 of 3 · Question \(index + 1) of \(PrefQuestion.all.count)").padding(.top, 20)
                    Text(question.title).font(.system(size: 32, weight: .bold)).padding(.top, 6)

                    TextEditor(text: text)
                        .scrollContentBackground(.hidden)
                        .padding(12)
                        .frame(height: 140)
                        .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(alignment: .topLeading) {
                            if text.wrappedValue.isEmpty {
                                Text(question.placeholder)
                                    .foregroundStyle(Color(uiColor: .placeholderText))
                                    .padding(.horizontal, 17).padding(.vertical, 20)
                                    .allowsHitTesting(false)
                            }
                        }
                        .padding(.top, 20)

                    Text("Quick picks").font(.footnote.weight(.medium)).padding(.top, 20)
                    FlowLayout(spacing: 8) {
                        ForEach(question.picks, id: \.self) { pick in
                            Button(pick) {
                                let current = text.wrappedValue.trimmingCharacters(in: .whitespaces)
                                if !current.localizedCaseInsensitiveContains(pick) {
                                    text.wrappedValue = current.isEmpty ? pick : "\(current), \(pick.lowercased())"
                                }
                            }
                            .buttonStyle(.plain)
                            .font(.footnote.weight(.medium))
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Color.chipFill, in: Capsule())
                        }
                    }
                    .padding(.top, 8)

                    Button("Skip question") { advance() }
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.top, 24)
                }
                .padding(.horizontal, 20)
            }
            .scrollDismissesKeyboard(.interactively)

            VStack(spacing: 10) {
                if !isLast {
                    Button("Next question") { advance() }.buttonStyle(.primary)
                    Button("Review answers and finish") { path.append(.prefsReview) }.buttonStyle(.secondary)
                } else {
                    Button("Review answers and finish") { path.append(.prefsReview) }.buttonStyle(.primary)
                }
            }
            .padding(20)
        }
        .navigationTitle("Setup")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Skip") { store.completeSetup() }
            }
        }
    }

    private func advance() {
        path.append(isLast ? .prefsReview : .prefs(index + 1))
    }
}

struct SetupPreferencesReviewView: View {
    @Environment(AppStore.self) private var store
    @Environment(SetupModel.self) private var model
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    StepBar(step: 3)
                    Eyebrow("Step 3 of 3").padding(.top, 20)
                    Text("Your study preferences").font(.system(size: 32, weight: .bold)).padding(.top, 6)
                    Text("You can change these any time from your profile.")
                        .foregroundStyle(Color.subtleText)
                        .padding(.top, 6)

                    RowGroup {
                        ForEach(PrefQuestion.all, id: \.summaryTitle) { question in
                            let value = model.prefs[keyPath: question.keyPath].trimmingCharacters(in: .whitespacesAndNewlines)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(question.summaryTitle).font(.footnote.weight(.medium)).foregroundStyle(Color.subtleText)
                                Text(value.isEmpty ? "Skipped" : value)
                                    .foregroundStyle(value.isEmpty ? Color.subtleText : Color.primary)
                            }
                        }
                    }
                    .padding(.top, 20)

                    if let errorMessage { ErrorBanner(message: errorMessage).padding(.top, 16) }
                }
                .padding(.horizontal, 20)
            }

            Button {
                finish()
            } label: {
                if isSaving { ProgressView().tint(Color.onBrand) } else { Text("Finish") }
            }
            .buttonStyle(.primary)
            .disabled(isSaving)
            .padding(20)
        }
        .navigationTitle("Setup")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func finish() {
        isSaving = true
        errorMessage = nil
        Task {
            do {
                if !model.prefs.isEmpty { try await store.savePreferences(model.prefs) }
                store.completeSetup()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}

// MARK: - Import from the calendar

/// The Canvas import (sign in or paste a link, then review) as a sheet, for use after setup.
struct CanvasImportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var path: [SetupStep] = []
    @State private var model = SetupModel()

    var body: some View {
        NavigationStack(path: $path) {
            SetupCanvasView(path: $path)
                .navigationDestination(for: SetupStep.self) { _ in
                    SetupReviewView(path: $path)
                }
        }
        .environment(model)
        .onAppear { model.onFinish = { dismiss() } }
    }
}
