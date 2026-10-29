//
//  Theme.swift
//  Minerva
//

import SwiftUI

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    static let brand = Color(light: 0x7C3AED, dark: 0xA78BFA)
    /// Text and icons drawn on a `brand` fill.
    static let onBrand = Color(light: 0xFFFFFF, dark: 0x140B26)
    static let brandSoft = Color(light: 0xF1EBFF, dark: 0x231A38)
    static let fieldFill = Color(light: 0xF4F4F6, dark: 0x161618)
    static let chipFill = Color(light: 0xE9E9EE, dark: 0x26262B)
    static let subtleText = Color(light: 0x45454F, dark: 0xC9C9D2)
    static let track = Color(light: 0xE9E9EE, dark: 0x26262B)

    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

// MARK: - Buttons

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Color.onBrand)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .background(Color.brand.opacity(isEnabled ? 1 : 0.4), in: RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct SoftButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(Color.brand)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .background(Color.brandSoft, in: RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// A white button with a hairline outline, for a secondary action beside a primary one.
struct OutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.primary)
            .padding(.horizontal, 24)
            .frame(height: 54)
            .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.track, lineWidth: 1.5))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { .init() }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    static var secondary: SecondaryButtonStyle { .init() }
}

extension ButtonStyle where Self == SoftButtonStyle {
    static var soft: SoftButtonStyle { .init() }
}

// MARK: - Containers

struct Card<Content: View>: View {
    var fill: Color = .fieldFill
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: 20))
    }
}

/// A rounded group whose rows are separated by hairlines, like the grouped lists in the designs.
struct RowGroup<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        Group(subviews: content) { subviews in
            VStack(spacing: 0) {
                ForEach(Array(subviews.enumerated()), id: \.offset) { index, subview in
                    if index > 0 { Divider().padding(.leading, 16) }
                    subview
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 20))
    }
}

struct Badge: View {
    let text: String
    var size: CGFloat = 44
    var tint: Color = .brand
    var fill: Color = .brandSoft

    var body: some View {
        Text(text)
            .font(.system(size: size * 0.3, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(fill, in: RoundedRectangle(cornerRadius: size * 0.3))
    }
}

struct Chip: View {
    let text: String
    var tint: Color = .primary
    var fill: Color = .chipFill

    var body: some View {
        Text(text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(tint)
            .lineLimit(1)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(fill, in: Capsule())
    }
}

struct DateBadge: View {
    let date: Date

    var body: some View {
        VStack(spacing: 0) {
            Text(date.formatted(.dateTime.month(.abbreviated)).uppercased())
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color.brand)
            Text(date.formatted(.dateTime.day()))
                .font(.system(size: 20, weight: .semibold))
        }
        .frame(width: 48, height: 48)
        .background(Color(light: 0xFFFFFF, dark: 0x000000), in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Progress

struct SegmentedProgress: View {
    let total: Int
    let done: Int
    var height: CGFloat = 4

    var body: some View {
        HStack(spacing: 4) {
            if total == 0 {
                Capsule().fill(Color.track).frame(height: height)
            } else {
                ForEach(0..<total, id: \.self) { index in
                    Capsule()
                        .fill(index < done ? Color.brand : Color.track)
                        .frame(height: height)
                }
            }
        }
    }
}

struct StepBar: View {
    let step: Int
    var total = 3

    var body: some View {
        HStack(spacing: 6) {
            ForEach(1...total, id: \.self) { index in
                Capsule()
                    .fill(index <= step ? Color.brand : Color.track)
                    .frame(height: 4)
            }
        }
    }
}

struct CheckCircle: View {
    let checked: Bool

    var body: some View {
        Image(systemName: checked ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 26))
            .foregroundStyle(checked ? Color.brand : Color.secondary)
    }
}

// MARK: - Text

struct FieldLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(.primary)
    }
}

struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.bold))
            .tracking(0.5)
            .foregroundStyle(Color.brand)
    }
}

struct SectionHeader: View {
    let title: String
    var action: String?
    var onAction: (() -> Void)?

    var body: some View {
        HStack {
            Text(title).font(.title3.weight(.semibold))
            Spacer()
            if let action, let onAction {
                Button(action, action: onAction)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.brand)
            }
        }
    }
}

struct MinervaTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
    }
}

extension TextFieldStyle where Self == MinervaTextFieldStyle {
    static var minerva: MinervaTextFieldStyle { .init() }
}

/// A labelled gray field row used for pickers that look like dropdowns.
struct DropdownRow<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        HStack {
            content
            Spacer(minLength: 8)
            Image(systemName: "chevron.down")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
        .background(Color.fieldFill, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct LabeledField<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            FieldLabel(label)
            content
        }
    }
}

struct ErrorBanner: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
