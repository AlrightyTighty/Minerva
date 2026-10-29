//
//  CanvasLoginView.swift
//  Minerva
//
//  Signs in to a school's Canvas in a web view, so single sign-on works, then reads the calendar feed link
//  from the signed-in session. Minerva never sees the student's password.
//

import SwiftUI
import WebKit

enum CanvasLoginPhase {
    case signingIn, findingCalendar
}

struct CanvasLoginSheet: View {
    @Environment(\.dismiss) private var dismiss
    let school: CanvasSchool
    let onLink: (URL) -> Void
    @State private var phase = CanvasLoginPhase.signingIn
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                CanvasWebView(school: school, phase: $phase, onLink: { url in
                    dismiss()
                    onLink(url)
                }, onFailure: { failure = $0 })
                .ignoresSafeArea(edges: .bottom)

                if phase == .findingCalendar, failure == nil {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Finding your calendar…").font(.subheadline.weight(.medium))
                    }
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 24)
                }
                if let failure {
                    ErrorBanner(message: failure)
                        .padding(16)
                        .background(.bar)
                }
            }
            .navigationTitle(school.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}

private struct CanvasWebView: UIViewRepresentable {
    let school: CanvasSchool
    @Binding var phase: CanvasLoginPhase
    let onLink: (URL) -> Void
    let onFailure: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Nothing is kept afterwards, so the next person to import isn't already signed in as this one.
        configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        if let url = URL(string: "https://\(school.host)/login") { web.load(URLRequest(url: url)) }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: CanvasWebView
        private var openedCalendar = false
        private var finished = false
        private var attempts = 0

        init(_ parent: CanvasWebView) {
            self.parent = parent
        }

        /// Asks the page, using the student's session, who they are and what their calendar feed is. Canvas
        /// puts the feed in the profile (`calendar.ics`). If it isn't there, the calendar page itself is searched.
        private static let script = """
        let loggedIn = false, ics = null;
        try {
          const r = await fetch('/api/v1/users/self/profile', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
          if (r.ok) {
            loggedIn = true;
            const text = (await r.text()).replace(/^while\\(1\\);/, '');
            const profile = JSON.parse(text);
            ics = (profile.calendar && profile.calendar.ics) || null;
          }
        } catch (e) {}
        if (loggedIn && !ics) {
          const match = document.documentElement.innerHTML.match(/https?:\\/\\/[^"'\\s<>\\\\]+\\/feeds\\/calendars\\/user_[A-Za-z0-9_]+\\.ics/);
          if (match) ics = match[0];
        }
        return { loggedIn: loggedIn, ics: ics };
        """

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !finished, let url = webView.url, url.host?.lowercased() == parent.school.host else { return }
            Task { await inspect(webView, url: url) }
        }

        private func inspect(_ webView: WKWebView, url: URL) async {
            let result = try? await webView.callAsyncJavaScript(Self.script, contentWorld: .page) as? [String: Any]
            guard !finished, result?["loggedIn"] as? Bool == true else { return }

            let onCalendar = url.path.hasPrefix("/calendar")
            if !onCalendar && !openedCalendar {
                // Signed in: go to the calendar, which is where the feed lives.
                openedCalendar = true
                parent.phase = .findingCalendar
                if let calendar = URL(string: "https://\(parent.school.host)/calendar") { webView.load(URLRequest(url: calendar)) }
                return
            }
            guard onCalendar else { return }
            parent.phase = .findingCalendar

            if let link = (result?["ics"] as? String).flatMap(CanvasFeed.normalize) {
                finished = true
                webView.stopLoading()
                parent.onLink(link)
            } else if attempts < 3 {
                // The calendar page builds itself after it loads, so look again shortly.
                attempts += 1
                try? await Task.sleep(for: .seconds(1.5))
                await inspect(webView, url: url)
            } else {
                parent.onFailure("Signed in, but we couldn't find your calendar link. You can paste it in instead.")
            }
        }

        // Sign-in pages sometimes open in a new window. Keep them in this one.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
            return nil
        }
    }
}
