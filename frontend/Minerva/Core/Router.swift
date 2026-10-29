//
//  Router.swift
//  Minerva
//

import Foundation
import Observation

enum AppTab: Hashable {
    case home, calendar, plans, chat
}

/// Screens pushed inside the Work plans and Chat tabs.
enum Route: Hashable {
    case plan(String)
    case chat(ChatThread)
}

struct ItemRef: Identifiable, Hashable {
    let id: String
}

struct NewChatRequest: Identifiable {
    let id = UUID()
    var courseId: String?
    var itemId: String?
}

struct AddItemRequest: Identifiable {
    let id = UUID()
    var day: Date
}

/// Navigation and presentation state for the signed-in app. Sheets live at the root so any screen can
/// open one, and so one sheet can hand off to another.
@Observable
final class Router {
    var tab = AppTab.home
    var plansPath: [Route] = []
    var chatPath: [Route] = []
    var itemDetail: ItemRef?
    var newChat: NewChatRequest?
    var addItem: AddItemRequest?
    var showPlanWizard = false
    var showProfile = false

    /// Shows a plan in the Work plans tab.
    func openPlan(_ id: String) {
        tab = .plans
        plansPath = [.plan(id)]
    }

    /// Shows a chat in the Chat tab.
    func openChat(_ thread: ChatThread) {
        tab = .chat
        chatPath = [.chat(thread)]
    }

    func reset() {
        tab = .home
        plansPath = []
        chatPath = []
        itemDetail = nil
        newChat = nil
        addItem = nil
        showPlanWizard = false
        showProfile = false
    }

    /// Dismisses the item sheet, then opens a new chat for it once the dismissal has finished.
    func startChat(courseId: String?, itemId: String?) {
        itemDetail = nil
        let request = NewChatRequest(courseId: courseId, itemId: itemId)
        Task {
            try? await Task.sleep(for: .milliseconds(450))
            newChat = request
        }
    }
}
