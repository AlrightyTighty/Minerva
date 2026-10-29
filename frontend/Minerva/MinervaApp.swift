//
//  MinervaApp.swift
//  Minerva
//
//  Created by Joshua Novak on 10/1/26.
//

import SwiftUI

@main
struct MinervaApp: App {
    @State private var store: AppStore
    @State private var plans: PlanStore
    @State private var router: Router

    init() {
        let store = AppStore()
        let plans = PlanStore(api: store.api)
        // Plans and assignments share completion state on the server, so each refetches when the other changes.
        store.onAssignmentCompletionChanged = { [weak plans] in await plans?.refresh() }
        plans.onItemCompletionChanged = { [weak store] in await store?.refreshAssignments() }
        let router = Router()
        store.onSignedOut = { [weak router, weak plans] in
            router?.reset()
            plans?.reset()
        }
        _router = State(initialValue: router)
        _store = State(initialValue: store)
        _plans = State(initialValue: plans)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(plans)
                .environment(router)
                .tint(.brand)
        }
    }
}

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(PlanStore.self) private var plans

    var body: some View {
        Group {
            if !store.isSignedIn {
                WelcomeView()
            } else if !store.setupDone {
                SetupFlow()
            } else {
                MainView()
            }
        }
        .animation(.default, value: store.isSignedIn)
        .animation(.default, value: store.setupDone)
        .task(id: store.isSignedIn) {
            await store.refresh()
            await plans.refresh()
        }
    }
}
