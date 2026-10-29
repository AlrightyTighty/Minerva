//
//  ChatView.swift
//  Minerva
//

import SwiftUI

struct ChatBubble: Identifiable, Equatable {
    let id: String
    let isUser: Bool
    var text: String
    var attachmentNames: [String] = []
    var isError = false
}

@Observable
final class ChatViewModel {
    let thread: ChatThread
    private(set) var bubbles: [ChatBubble] = []
    private(set) var isLoading = true
    private(set) var isStreaming = false
    private(set) var status: String?
    private(set) var errorMessage: String?
    private(set) var pending: [UploadJob] = []
    var input = ""

    private var streamTask: Task<Void, Never>?
    private var fileNames: [String: String] = [:]
    private var localCounter = 0

    init(thread: ChatThread) {
        self.thread = thread
    }

    func load(store: AppStore) async {
        async let files = try? store.api.listFiles(courseId: thread.courseId)
        async let messages = try? store.api.listMessages(courseId: thread.courseId, threadId: thread.threadId)
        fileNames = Dictionary(uniqueKeysWithValues: (await files ?? []).map { ($0.fileId, $0.title) })
        if let messages = await messages { bubbles = messages.map(bubble) }
        isLoading = false
    }

    private func bubble(_ message: Message) -> ChatBubble {
        ChatBubble(
            id: message.messageId,
            isUser: message.role == .user,
            text: message.text,
            attachmentNames: message.attachmentIds.map { fileNames[$0] ?? "Attachment" }
        )
    }

    // MARK: Attachments

    func attach(_ files: [PickedFile], store: AppStore) {
        for file in files where pending.count < 5 {
            let job = UploadJob(courseId: thread.courseId, file: file, docType: file.docTypeDefault)
            pending.append(job)
            store.enqueue(job)
        }
    }

    func removePending(_ job: UploadJob) {
        pending.removeAll { $0.id == job.id }
    }

    // MARK: Sending

    var canSend: Bool {
        !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isStreaming
    }

    func send(store: AppStore) {
        guard canSend else { return }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let jobs = pending
        input = ""
        pending = []
        errorMessage = nil
        isStreaming = true
        status = jobs.isEmpty ? nil : "Preparing files…"

        localCounter += 1
        let assistantId = "local-assistant-\(localCounter)"
        bubbles.append(ChatBubble(id: "local-user-\(localCounter)", isUser: true, text: text, attachmentNames: jobs.map(\.file.filename)))
        bubbles.append(ChatBubble(id: assistantId, isUser: false, text: ""))

        streamTask = Task {
            do {
                // Attachments have to be `ready` before they can go on a message.
                for job in jobs { try await store.waitUntilFinished(job) }
                let ids = jobs.compactMap(\.fileId)

                var finished = false
                for try await event in store.api.sendMessage(courseId: thread.courseId, threadId: thread.threadId, text: text, attachmentFileIds: ids) {
                    switch event {
                    case .toolStatus(let message):
                        status = message
                    case .text(let piece):
                        status = nil
                        append(piece, to: assistantId)
                    case .done(let messageId, _):
                        rename(assistantId, to: messageId)
                        store.touch(thread)
                        finished = true
                    case .error(let message):
                        fail(assistantId, message: message)
                        finished = true
                    }
                }
                if !finished { throw APIError(status: 0, message: "The connection ended before the reply finished.") }
            } catch is CancellationError {
                markStopped(assistantId)
            } catch let error as URLError where error.code == .cancelled {
                markStopped(assistantId)
            } catch {
                // The stream broke or the request was refused. The server may still have stored the reply.
                fail(assistantId, message: error.localizedDescription)
                await load(store: store)
            }
            isStreaming = false
            status = nil
        }
    }

    func stop() {
        streamTask?.cancel()
    }

    private func append(_ piece: String, to id: String) {
        guard let index = bubbles.firstIndex(where: { $0.id == id }) else { return }
        bubbles[index].text += piece
    }

    private func rename(_ id: String, to newId: String) {
        guard let index = bubbles.firstIndex(where: { $0.id == id }) else { return }
        bubbles[index] = ChatBubble(id: newId, isUser: false, text: bubbles[index].text)
    }

    private func fail(_ id: String, message: String) {
        guard let index = bubbles.firstIndex(where: { $0.id == id }) else { return }
        if bubbles[index].text.isEmpty {
            bubbles[index] = ChatBubble(id: id, isUser: false, text: message, isError: true)
        } else {
            errorMessage = message
        }
    }

    private func markStopped(_ id: String) {
        guard let index = bubbles.firstIndex(where: { $0.id == id }) else { return }
        if bubbles[index].text.isEmpty { bubbles.remove(at: index) }
    }
}

struct ChatView: View {
    @Environment(AppStore.self) private var store
    @State private var model: ChatViewModel
    @State private var showImporter = false
    @State private var importError: String?
    @FocusState private var focused: Bool

    init(thread: ChatThread) {
        _model = State(initialValue: ChatViewModel(thread: thread))
    }

    private var assignmentTitle: String? {
        model.thread.assignmentId.flatMap { store.item($0)?.title }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 12) {
                        FlowLayout {
                            Chip(text: store.courseLabel(model.thread.courseId), tint: .brand, fill: .brandSoft)
                            if let assignmentTitle { Chip(text: assignmentTitle, tint: .brand, fill: .brandSoft) }
                        }
                        Text("\(model.thread.createdAt.relativeDay) \(model.thread.createdAt.formatted(date: .omitted, time: .shortened))")
                            .font(.footnote).foregroundStyle(Color.subtleText)

                        if model.isLoading {
                            ProgressView().padding(.top, 24)
                        } else if model.bubbles.isEmpty {
                            Text("Ask a question to get started.").foregroundStyle(Color.subtleText).padding(.top, 24)
                        }

                        ForEach(model.bubbles) { bubble in
                            BubbleView(bubble: bubble)
                        }

                        if model.isStreaming {
                            HStack(spacing: 10) {
                                Text(model.status ?? "Writing…").font(.footnote).foregroundStyle(Color.subtleText)
                                Button("Stop") { model.stop() }
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.primary)
                                    .padding(.horizontal, 12).padding(.vertical, 6)
                                    .background(Color.chipFill, in: Capsule())
                                Spacer()
                            }
                        }
                        if let message = model.errorMessage {
                            ErrorBanner(message: message)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.bubbles) { _, _ in proxy.scrollTo("bottom") }
                .onChange(of: model.status) { _, _ in proxy.scrollTo("bottom") }
                .onChange(of: model.isLoading) { _, _ in proxy.scrollTo("bottom") }
            }

            inputBar
        }
        .navigationTitle(model.thread.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(store: store) }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: PickedFile.allowedTypes, allowsMultipleSelection: true) { result in
            do {
                model.attach(try result.get().map { try PickedFile.make(from: $0, allowImages: true) }, store: store)
            } catch {
                importError = error.localizedDescription
            }
        }
        .alert("Couldn't attach file", isPresented: Binding(get: { importError != nil }, set: { if !$0 { importError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(importError ?? "")
        }
    }

    private var inputBar: some View {
        @Bindable var model = model
        return VStack(spacing: 8) {
            if !model.pending.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(model.pending) { job in
                            PendingAttachment(job: job) { model.removePending(job) }
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                Button { showImporter = true } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 40, height: 40)
                        .background(Color.chipFill, in: Circle())
                }
                .accessibilityLabel("Attach file")
                .disabled(model.pending.count >= 5)

                TextField("Message", text: $model.input, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($focused)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.chipFill, in: RoundedRectangle(cornerRadius: 20))

                Button {
                    model.send(store: store)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(Color.onBrand)
                        .frame(width: 40, height: 40)
                        .background(Color.brand.opacity(model.canSend ? 1 : 0.4), in: Circle())
                }
                .accessibilityLabel("Send")
                .disabled(!model.canSend)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

private struct PendingAttachment: View {
    let job: UploadJob
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if job.isFailed {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
            } else if !job.isReady {
                ProgressView().controlSize(.small)
            }
            Text(job.file.filename).font(.footnote.weight(.medium)).lineLimit(1)
            Button(action: remove) { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color.brandSoft, in: Capsule())
    }
}

private struct BubbleView: View {
    let bubble: ChatBubble

    var body: some View {
        HStack {
            if bubble.isUser { Spacer(minLength: 48) }
            VStack(alignment: bubble.isUser ? .trailing : .leading, spacing: 6) {
                ForEach(bubble.attachmentNames, id: \.self) { name in
                    Label(name, systemImage: "paperclip")
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Color.brandSoft, in: Capsule())
                        .foregroundStyle(Color.brand)
                }
                if !bubble.text.isEmpty {
                    content
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .background(
                            bubble.isUser ? Color.brand : Color.fieldFill,
                            in: RoundedRectangle(cornerRadius: 20)
                        )
                        .textSelection(.enabled)
                }
            }
            if !bubble.isUser { Spacer(minLength: bubble.isError ? 48 : 0) }
        }
        .frame(maxWidth: .infinity, alignment: bubble.isUser ? .trailing : .leading)
    }

    /// The student's own messages stay plain; the assistant's replies are Markdown with LaTeX.
    @ViewBuilder
    private var content: some View {
        if bubble.isUser {
            Text(verbatim: bubble.text).foregroundStyle(Color.onBrand)
        } else if bubble.isError {
            Text(verbatim: bubble.text).foregroundStyle(Color.red)
        } else {
            MarkdownView(text: bubble.text)
        }
    }
}

// MARK: - Thread list

struct HelpListView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Button("Ask for help") { router.newChat = NewChatRequest() }.buttonStyle(.soft)
                if store.recentThreads.isEmpty {
                    Text("No chats yet.").foregroundStyle(Color.subtleText).padding(.top, 24)
                } else {
                    RowGroup {
                        ForEach(store.recentThreads) { ThreadRow(thread: $0) }
                    }
                }
            }
            .padding(20)
        }
        .refreshable { await store.refreshThreads() }
        .navigationTitle("Chat")
        .navigationBarTitleDisplayMode(.inline)
    }
}
