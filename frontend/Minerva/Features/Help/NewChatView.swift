//
//  NewChatView.swift
//  Minerva
//

import SwiftUI

struct NewChatView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    let request: NewChatRequest

    @State private var courseId: String?
    @State private var itemId: String?
    @State private var mode: ThreadMode = .conceptReview
    @State private var modeChosen = false
    @State private var attachments: [PickedFile] = []
    @State private var showImporter = false
    @State private var isStarting = false
    @State private var progressText: String?
    @State private var errorMessage: String?

    init(request: NewChatRequest) {
        self.request = request
        _courseId = State(initialValue: request.courseId)
        _itemId = State(initialValue: request.itemId)
    }

    /// Items the student can attach the chat to: those of the chosen course, or the course-less ones.
    private var itemsForCourse: [CalendarItem] {
        store.calendarItems.filter { $0.courseId == courseId }
    }

    private var selectedItem: CalendarItem? { itemId.flatMap { store.item($0) } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("What do you need help with?").font(.system(size: 32, weight: .bold))
                    Text("Pick a course and item, or leave both as None for general study advice.")
                        .foregroundStyle(Color.subtleText).padding(.top, 6)

                    VStack(alignment: .leading, spacing: 16) {
                        LabeledField(label: "Course") {
                            CoursePicker(selection: $courseId)
                        }
                        LabeledField(label: "Calendar item") {
                            Menu {
                                Button("None") { itemId = nil }
                                ForEach(itemsForCourse) { item in
                                    Button(item.title) { itemId = item.id }
                                }
                            } label: {
                                DropdownRow {
                                    Text(selectedItem?.title ?? "None").foregroundStyle(.primary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                        LabeledField(label: "Type of help") {
                            Menu {
                                ForEach(ThreadMode.allCases) { option in
                                    Button(option.label) { mode = option; modeChosen = true }
                                }
                            } label: {
                                DropdownRow { Text(mode.label).foregroundStyle(.primary) }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 20)

                    Text("Attachments").font(.title3.weight(.semibold)).padding(.top, 24)
                    VStack(spacing: 10) {
                        ForEach(attachments) { file in
                            HStack(spacing: 12) {
                                Badge(text: file.isImage ? "IMG" : "PDF", size: 40)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(file.filename).font(.subheadline.weight(.semibold)).lineLimit(1)
                                    Text(file.sizeText).font(.footnote).foregroundStyle(Color.subtleText)
                                }
                                Spacer(minLength: 8)
                                Button("Remove") { attachments.removeAll { $0.id == file.id } }
                                    .font(.subheadline.weight(.medium))
                            }
                            .padding(12)
                            .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 16))
                        }
                        if attachments.count < 5 {
                            Button("Attach file") { showImporter = true }.buttonStyle(.soft)
                        }
                    }
                    .padding(.top, 10)

                    if let progressText { Text(progressText).font(.footnote).foregroundStyle(Color.subtleText).padding(.top, 16) }
                    if let errorMessage { ErrorBanner(message: errorMessage).padding(.top, 16) }
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .disabled(isStarting)

            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isStarting) }
                ToolbarItem(placement: .confirmationAction) {
                    if isStarting {
                        ProgressView()
                    } else {
                        Button("Start") { start() }.fontWeight(.semibold)
                    }
                }
            }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: PickedFile.allowedTypes, allowsMultipleSelection: true) { result in
                do {
                    let files = try result.get().map { try PickedFile.make(from: $0, allowImages: true) }
                    attachments = Array((attachments + files).prefix(5))
                    errorMessage = nil
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
            .onAppear(perform: seedFromItem)
            .onChange(of: courseId) { _, newValue in
                if let item = selectedItem, item.courseId != newValue { itemId = nil }
            }
            .onChange(of: itemId) { _, _ in
                if !modeChosen { mode = selectedItem?.assignmentId != nil ? .assignmentHelp : .conceptReview }
            }
        }
    }

    private func seedFromItem() {
        guard let item = selectedItem else { return }
        if courseId == nil { courseId = item.courseId }
        if !modeChosen { mode = item.assignmentId != nil ? .assignmentHelp : .conceptReview }
        if item.courseId == nil { itemId = item.id }
    }

    private func start() {
        isStarting = true
        errorMessage = nil
        Task {
            do {
                progressText = nil
                let course: Course
                if let existing = store.course(courseId) {
                    course = existing
                } else {
                    course = try await store.generalCourse()
                }

                // Only `ready` files can be pinned, so wait for the uploads before making the thread.
                var pinned: [String] = []
                if !attachments.isEmpty {
                    progressText = "Preparing files…"
                    let jobs = attachments.map { UploadJob(courseId: course.courseId, file: $0, docType: $0.docTypeDefault) }
                    jobs.forEach(store.enqueue)
                    for job in jobs {
                        try await store.waitUntilFinished(job)
                        if let id = job.fileId { pinned.append(id) }
                    }
                }

                let item = selectedItem
                let assignmentId = item?.courseId == course.courseId ? item?.assignmentId : nil
                let title = item.map { "\($0.title) help" } ?? (courseId == nil ? "Study help" : "\(store.displayName(course.courseId)) chat")
                let thread = try await store.startThread(courseId: course.courseId, mode: mode, title: title, assignmentId: assignmentId, pinned: pinned)
                dismiss()
                router.openChat(thread)
            } catch {
                errorMessage = error.localizedDescription
            }
            isStarting = false
        }
    }
}
