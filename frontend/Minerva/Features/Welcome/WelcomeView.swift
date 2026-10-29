//
//  WelcomeView.swift
//  Minerva
//

import SwiftUI

/// The password rules the API enforces. Checking here gives the student a message before the request.
enum PasswordRules {
    static let range = 10...128

    static func isValid(_ password: String) -> Bool { range.contains(password.count) }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    var looksLikeEmail: Bool { trimmed.contains("@") && trimmed.count <= 254 }
}

struct WelcomeView: View {
    @Environment(AppStore.self) private var store
    @State private var email = ""
    @State private var password = ""
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var showCreateAccount = false

    private var canSubmit: Bool { email.looksLikeEmail && !password.isEmpty && !isWorking }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("M")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(Color.onBrand)
                    .frame(width: 64, height: 64)
                    .background(Color.brand, in: RoundedRectangle(cornerRadius: 18))
                    .padding(.top, 48)

                Text("Minerva")
                    .font(.system(size: 34, weight: .bold))
                    .padding(.top, 20)

                Text("Your study buddy for every course. Sign in to keep courses, plans and chats on every device.")
                    .font(.body)
                    .foregroundStyle(Color.subtleText)
                    .padding(.top, 8)

                VStack(alignment: .leading, spacing: 16) {
                    LabeledField(label: "Email") {
                        TextField("you@school.edu", text: $email)
                            .textFieldStyle(.minerva)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    LabeledField(label: "Password") {
                        SecureField("Password", text: $password)
                            .textFieldStyle(.minerva)
                            .textContentType(.password)
                            .onSubmit { if canSubmit { signIn() } }
                    }
                    if let errorMessage { ErrorBanner(message: errorMessage) }
                    Button {
                        signIn()
                    } label: {
                        if isWorking { ProgressView().tint(Color.onBrand) } else { Text("Sign in") }
                    }
                    .buttonStyle(.primary)
                    .disabled(!canSubmit)
                }
                .padding(.top, 32)

                HStack(spacing: 6) {
                    Text("New to Minerva?").foregroundStyle(Color.subtleText)
                    Button("Create account") { showCreateAccount = true }.fontWeight(.semibold)
                }
                .font(.subheadline)
                .frame(maxWidth: .infinity)
                .padding(.top, 20)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $showCreateAccount) {
            CreateAccountSheet(email: email)
        }
    }

    private func signIn() {
        isWorking = true
        errorMessage = nil
        Task {
            do {
                try await store.signIn(email: email.trimmed, password: password)
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }
}

private struct CreateAccountSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var firstName = ""
    @State private var lastName = ""
    @State private var email: String
    @State private var password = ""
    @State private var isWorking = false
    @State private var errorMessage: String?

    init(email: String) {
        _email = State(initialValue: email)
    }

    private var passwordProblem: String? {
        guard !password.isEmpty, !PasswordRules.isValid(password) else { return nil }
        return password.count < PasswordRules.range.lowerBound
            ? "Use at least \(PasswordRules.range.lowerBound) characters."
            : "Use at most \(PasswordRules.range.upperBound) characters."
    }

    private var canSubmit: Bool {
        !firstName.trimmed.isEmpty && !lastName.trimmed.isEmpty && email.looksLikeEmail
            && PasswordRules.isValid(password) && !isWorking
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        LabeledField(label: "First name") {
                            TextField("First name", text: $firstName)
                                .textFieldStyle(.minerva)
                                .textContentType(.givenName)
                        }
                        LabeledField(label: "Last name") {
                            TextField("Last name", text: $lastName)
                                .textFieldStyle(.minerva)
                                .textContentType(.familyName)
                        }
                    }
                    LabeledField(label: "Email") {
                        TextField("you@school.edu", text: $email)
                            .textFieldStyle(.minerva)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    LabeledField(label: "Password") {
                        SecureField("At least 10 characters", text: $password)
                            .textFieldStyle(.minerva)
                            .textContentType(.newPassword)
                        if let passwordProblem {
                            Text(passwordProblem).font(.footnote).foregroundStyle(.red)
                        }
                        Text("There's no way to reset a forgotten password yet, so keep it somewhere safe.")
                            .font(.footnote).foregroundStyle(Color.subtleText)
                    }
                    if let errorMessage { ErrorBanner(message: errorMessage) }
                    Button {
                        submit()
                    } label: {
                        if isWorking { ProgressView().tint(Color.onBrand) } else { Text("Create account") }
                    }
                    .buttonStyle(.primary)
                    .disabled(!canSubmit)
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Create account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func submit() {
        isWorking = true
        errorMessage = nil
        Task {
            do {
                try await store.signUp(firstName: firstName.trimmed, lastName: lastName.trimmed, email: email.trimmed, password: password)
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }
}
