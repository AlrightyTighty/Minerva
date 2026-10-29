//
//  ProfileSheet.swift
//  Minerva
//

import SwiftUI

struct ProfileSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private static let limit = 500

    @State private var preferences = ""
    @State private var loadedPreferences = ""
    @State private var didLoad = false
    @State private var isSaving = false
    @State private var message: String?
    @State private var messageIsError = false
    @State private var showAddCourse = false
    @State private var showChangePassword = false
    @State private var confirmSignOut = false

    private var trimmed: String { preferences.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isDirty: Bool { trimmed != loadedPreferences }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text([store.user?.firstName, store.user?.lastName].compactMap { $0 }.joined(separator: " "))
                            .font(.system(size: 28, weight: .bold))
                        Text(store.user?.email ?? "").foregroundStyle(Color.subtleText)
                    }

                    preferencesSection
                    coursesSection

                    VStack(spacing: 12) {
                        Button("Change password") { showChangePassword = true }
                            .buttonStyle(.secondary)
                        Button("Sign out", role: .destructive) { confirmSignOut = true }
                            .buttonStyle(.secondary)
                    }
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(isPresented: $showAddCourse) { AddCourseSheet() }
            .sheet(isPresented: $showChangePassword) { ChangePasswordSheet() }
            .confirmationDialog("Sign out of Minerva?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { store.signOut() }
            } message: {
                Text("You'll need your email and password to get back in. There's no way to reset a forgotten password yet.")
            }
            .onAppear {
                guard !didLoad else { return }
                didLoad = true
                let current = store.user?.studyPreferences ?? ""
                preferences = current
                loadedPreferences = current
            }
        }
        .presentationDragIndicator(.visible)
    }

    private var preferencesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Study preferences").font(.title3.weight(.semibold))
            Text("How you like things explained and how you like to study. Minerva uses this in every chat.")
                .font(.subheadline).foregroundStyle(Color.subtleText)

            TextEditor(text: $preferences)
                .scrollContentBackground(.hidden)
                .padding(12)
                .frame(height: 140)
                .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 16))
                .onChange(of: preferences) { _, value in
                    // The API rejects anything over 500 characters, so stop the student at the limit.
                    if value.count > Self.limit { preferences = String(value.prefix(Self.limit)) }
                    message = nil
                }

            HStack {
                if let message {
                    Text(message).font(.footnote).foregroundStyle(messageIsError ? Color.red : Color.subtleText)
                }
                Spacer()
                Text("\(preferences.count)/\(Self.limit)").font(.footnote).foregroundStyle(Color.subtleText)
            }

            Button {
                save()
            } label: {
                if isSaving { ProgressView().tint(Color.onBrand) } else { Text("Save preferences") }
            }
            .buttonStyle(.primary)
            .disabled(!isDirty || isSaving)
        }
    }

    private var coursesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Courses").font(.title3.weight(.semibold))
            if !store.pickableCourses.isEmpty {
                RowGroup {
                    ForEach(store.pickableCourses) { course in
                        HStack(spacing: 12) {
                            Badge(text: store.initials(course.courseId), size: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(store.displayName(course.courseId)).font(.headline)
                                Text([store.code(course.courseId), store.term(course.courseId)].compactMap { $0 }.joined(separator: " · "))
                                    .font(.subheadline).foregroundStyle(Color.subtleText)
                            }
                        }
                    }
                }
            }
            Button("Add course") { showAddCourse = true }.buttonStyle(.soft)
        }
    }

    private func save() {
        isSaving = true
        message = nil
        Task {
            do {
                try await store.updateStudyPreferences(trimmed.isEmpty ? nil : trimmed)
                loadedPreferences = trimmed
                preferences = trimmed
                messageIsError = false
                message = "Saved"
            } catch {
                messageIsError = true
                message = error.localizedDescription
            }
            isSaving = false
        }
    }
}

// MARK: - Change password

private struct ChangePasswordSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var new = ""
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var changed = false

    private var canSubmit: Bool { !current.isEmpty && PasswordRules.isValid(new) && !isWorking }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if changed {
                        Text("Your password was changed. You've been signed out of every other device.")
                            .foregroundStyle(Color.subtleText)
                        Button("Done") { dismiss() }.buttonStyle(.primary)
                    } else {
                        LabeledField(label: "Current password") {
                            SecureField("Current password", text: $current)
                                .textFieldStyle(.minerva)
                                .textContentType(.password)
                        }
                        LabeledField(label: "New password") {
                            SecureField("At least 10 characters", text: $new)
                                .textFieldStyle(.minerva)
                                .textContentType(.newPassword)
                            Text("This signs you out of every other device.")
                                .font(.footnote).foregroundStyle(Color.subtleText)
                        }
                        if let errorMessage { ErrorBanner(message: errorMessage) }
                        Button {
                            submit()
                        } label: {
                            if isWorking { ProgressView().tint(Color.onBrand) } else { Text("Change password") }
                        }
                        .buttonStyle(.primary)
                        .disabled(!canSubmit)
                    }
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Change password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(changed ? "Close" : "Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() {
        isWorking = true
        errorMessage = nil
        Task {
            do {
                try await store.api.changePassword(current: current, new: new)
                current = ""
                new = ""
                changed = true
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }
}
