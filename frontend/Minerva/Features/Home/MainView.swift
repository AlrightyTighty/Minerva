//
//  MainView.swift
//  Minerva
//

import SwiftUI

struct MainView: View {
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                NavigationStack { HomeView() }
            }
            Tab("Calendar", systemImage: "calendar", value: AppTab.calendar) {
                NavigationStack { CalendarView() }
            }
            Tab("Work plans", systemImage: "list.bullet.rectangle", value: AppTab.plans) {
                NavigationStack(path: $router.plansPath) {
                    PlansListView().navigationDestination(for: Route.self, destination: destination)
                }
            }
            Tab("Chat", systemImage: "message", value: AppTab.chat) {
                NavigationStack(path: $router.chatPath) {
                    HelpListView().navigationDestination(for: Route.self, destination: destination)
                }
            }
        }
        .sheet(item: $router.itemDetail) { ref in
            ItemDetailSheet(itemId: ref.id)
        }
        .sheet(item: $router.addItem) { request in
            AddItemSheet(initialDay: request.day)
        }
        .sheet(isPresented: $router.showProfile) {
            ProfileSheet()
        }
        .fullScreenCover(item: $router.newChat) { request in
            NewChatView(request: request)
        }
        .fullScreenCover(isPresented: $router.showPlanWizard) {
            PlanWizard()
        }
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .plan(let id): PlanDetailView(planId: id)
        case .chat(let thread): ChatView(thread: thread)
        }
    }
}

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @Environment(PlanStore.self) private var plans
    @Environment(Router.self) private var router

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: .now)
        let part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"
        return store.firstName.isEmpty ? "Good \(part)" : "Good \(part), \(store.firstName)"
    }

    private var openItems: [CalendarItem] {
        let today = Calendar.current.startOfDay(for: .now)
        return store.calendarItems.filter { !$0.completed && $0.day >= today }
    }

    private var dueThisWeek: Int {
        let end = Calendar.current.date(byAdding: .day, value: 7, to: Calendar.current.startOfDay(for: .now))!
        return openItems.filter { $0.day < end }.count
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header

                VStack(alignment: .leading, spacing: 4) {
                    Text(greeting).font(.system(size: 32, weight: .bold))
                    Text(dueThisWeek == 1 ? "1 item due this week" : "\(dueThisWeek) items due this week")
                        .foregroundStyle(Color.subtleText)
                }

                workPlanSection
                upcomingSection

                Button("Ask for help") { router.newChat = NewChatRequest() }
                    .buttonStyle(.soft)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 32)
        }
        .refreshable { await store.refresh() }
        .toolbar(.hidden, for: .navigationBar)
    }

    private var header: some View {
        HStack {
            Text("MINERVA").font(.caption.weight(.bold)).tracking(1).foregroundStyle(Color.brand)
            Spacer()
            Button { router.showProfile = true } label: {
                Text(initials)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.primary)
                    .frame(width: 40, height: 40)
                    .background(Color.chipFill, in: Circle())
            }
            .accessibilityLabel("Profile")
        }
    }

    private var initials: String {
        let letters = [store.user?.firstName, store.user?.lastName].compactMap { $0?.first }.map(String.init).joined()
        return letters.isEmpty ? "?" : letters.uppercased()
    }

    // MARK: Work plan

    private var workPlanSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Work plan", action: "+ New plan") { router.showPlanWizard = true }

            if let plan = plans.latest {
                Card(fill: .brandSoft) {
                    VStack(alignment: .leading, spacing: 12) {
                        Eyebrow("Latest plan")
                        Text(plan.title).font(.title2.weight(.bold))
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(plan.rangeText) · \(plan.doneCount) of \(plan.workItems.count) done")
                                .font(.subheadline).foregroundStyle(Color.subtleText)
                            SolidProgress(fraction: plan.fraction)
                        }
                        ForEach(plan.workItems.filter { !$0.isDone }.prefix(3)) { item in
                            PlanItemRow(plan: plan, item: item, showHelp: false)
                        }
                    }
                }
                .onTapGesture { router.openPlan(plan.workPlanId) }
            } else {
                Card {
                    Text("No work plan yet. Tap \"+ New plan\" to schedule your assignments.")
                        .font(.subheadline).foregroundStyle(Color.subtleText)
                }
            }
        }
    }

    // MARK: Upcoming

    private var upcomingSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Upcoming")

            if openItems.isEmpty {
                Card {
                    Text("Nothing due. Add an item from the calendar or import your Canvas events.")
                        .font(.subheadline).foregroundStyle(Color.subtleText)
                }
            } else {
                RowGroup {
                    ForEach(openItems.prefix(3)) { item in
                        Button { router.itemDetail = ItemRef(id: item.id) } label: {
                            HStack(spacing: 14) {
                                DateBadge(date: item.day)
                                ItemSummary(item: item)
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

/// Title plus "COURSE · time" for a calendar item.
struct ItemSummary: View {
    @Environment(AppStore.self) private var store
    let item: CalendarItem

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.title).font(.headline).lineLimit(1)
            Text(subtitle).font(.subheadline).foregroundStyle(Color.subtleText).lineLimit(1)
        }
    }

    private var subtitle: String {
        [item.courseId == nil ? nil : store.courseLabel(item.courseId), item.timeText ?? "No time"]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
}

struct SolidProgress: View {
    let fraction: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.track)
                Capsule().fill(Color.brand).frame(width: proxy.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 4)
    }
}

struct ThreadRow: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    let thread: ChatThread

    var body: some View {
        Button { router.openChat(thread) } label: {
            HStack(spacing: 12) {
                Badge(text: store.initials(thread.courseId), size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(thread.title).font(.headline).lineLimit(1)
                    Text("\(store.courseLabel(thread.courseId)) · \(thread.updatedAt.relativeDay)")
                        .font(.subheadline).foregroundStyle(Color.subtleText).lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
    }
}
