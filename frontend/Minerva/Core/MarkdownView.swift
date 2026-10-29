//
//  MarkdownView.swift
//  Minerva
//
//  Renders the assistant's Markdown with native SwiftUI views, so everything follows Dynamic Type.
//

import SwiftUI
import SwiftMath

// MARK: - Math rendering

struct MathImage {
    let image: UIImage
    /// How far the formula's baseline sits above the bottom of the image.
    let descent: CGFloat
}

enum MathRenderer {
    private final class Box { let value: MathImage?; init(_ value: MathImage?) { self.value = value } }
    private static let cache = NSCache<NSString, Box>()

    /// Typesets LaTeX into a template image (so it takes the text colour). `nil` if it isn't valid LaTeX.
    static func render(_ latex: String, size: CGFloat, display: Bool) -> MathImage? {
        let key = "\(display ? "d" : "t")|\(size)|\(latex)" as NSString
        if let cached = cache.object(forKey: key) { return cached.value }

        let label = MTMathUILabel()
        label.latex = latex
        label.fontSize = size
        label.textColor = .black
        label.labelMode = display ? .display : .text
        label.textAlignment = .left
        label.backgroundColor = .clear

        var result: MathImage?
        if label.error == nil {
            let fitted = label.intrinsicContentSize
            if fitted.width > 0, fitted.height > 0 {
                label.frame = CGRect(origin: .zero, size: fitted)
                label.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(size: fitted).image { context in
                    // The label flips its layer for UIKit, so flip back when drawing it into an image.
                    context.cgContext.translateBy(x: 0, y: fitted.height)
                    context.cgContext.scaleBy(x: 1, y: -1)
                    label.layer.render(in: context.cgContext)
                }
                result = MathImage(image: image.withRenderingMode(.alwaysTemplate), descent: label.displayList?.descent ?? 0)
            }
        }
        cache.setObject(Box(result), forKey: key)
        return result
    }
}

// MARK: - Root

struct MarkdownView: View {
    let text: String
    @ScaledMetric(relativeTo: .body) private var mathSize: CGFloat = 17

    var body: some View {
        let blocks = MarkdownParser.parse(text)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block, mathSize: mathSize, depth: 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Blocks

private struct BlockView: View {
    let block: MDBlock
    let mathSize: CGFloat
    let depth: Int

    var body: some View {
        switch block {
        case .paragraph(let inlines):
            InlineText.make(inlines, mathSize: mathSize)
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let inlines):
            InlineText.make(inlines, mathSize: mathSize)
                .font(Self.headingFont(level))
                .fontWeight(.bold)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, level <= 2 ? 4 : 0)
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .quote(let blocks):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(Color.brand.opacity(0.5)).frame(width: 3)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, inner in
                        BlockView(block: inner, mathSize: mathSize, depth: depth)
                    }
                }
                .foregroundStyle(Color.subtleText)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        marker(ordered: ordered, number: start + index, item: item)
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(Array(item.blocks.enumerated()), id: \.offset) { _, inner in
                                BlockView(block: inner, mathSize: mathSize, depth: depth + 1)
                            }
                        }
                    }
                }
            }
        case .table(let header, let alignments, let rows):
            TableBlockView(header: header, alignments: alignments, rows: rows, mathSize: mathSize)
        case .rule:
            Divider()
        case .displayMath(let latex):
            DisplayMathView(latex: latex, size: mathSize * 1.15)
        }
    }

    @ViewBuilder
    private func marker(ordered: Bool, number: Int, item: MDListItem) -> some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .foregroundStyle(checked ? Color.brand : Color.secondary)
        } else if ordered {
            Text("\(number).").monospacedDigit().foregroundStyle(Color.subtleText)
        } else {
            Text(depth == 0 ? "•" : "◦").foregroundStyle(Color.subtleText)
        }
    }

    private static func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2
        case 2: .title3
        case 3: .headline
        default: .subheadline
        }
    }
}

// MARK: - Inline text

private enum InlineText {
    /// Builds one `Text` out of the inline nodes. Formulas go in as inline images lowered onto the baseline, so
    /// they flow and wrap with the sentence.
    static func make(_ inlines: [MDInline], mathSize: CGFloat, bold: Bool = false, italic: Bool = false, strike: Bool = false) -> Text {
        inlines.reduce(Text("")) { partial, node in
            Text("\(partial)\(leaf(node, mathSize: mathSize, bold: bold, italic: italic, strike: strike))")
        }
    }

    private static func styled(_ text: Text, bold: Bool, italic: Bool, strike: Bool) -> Text {
        var text = text
        if bold { text = text.bold() }
        if italic { text = text.italic() }
        if strike { text = text.strikethrough() }
        return text
    }

    private static func leaf(_ node: MDInline, mathSize: CGFloat, bold: Bool, italic: Bool, strike: Bool) -> Text {
        switch node {
        case .text(let string):
            return styled(Text(verbatim: string), bold: bold, italic: italic, strike: strike)
        case .strong(let inner):
            return make(inner, mathSize: mathSize, bold: true, italic: italic, strike: strike)
        case .emphasis(let inner):
            return make(inner, mathSize: mathSize, bold: bold, italic: true, strike: strike)
        case .strikethrough(let inner):
            return make(inner, mathSize: mathSize, bold: bold, italic: italic, strike: true)
        case .code(let code):
            return styled(Text(verbatim: code).monospaced().foregroundStyle(Color.brand), bold: bold, italic: italic, strike: strike)
        case .link(let inner, let url):
            var label = AttributedString(plainText(inner))
            label.link = url
            return styled(Text(label), bold: bold, italic: italic, strike: strike)
        case .math(let latex, let display):
            let size = display ? mathSize * 1.15 : mathSize
            guard let math = MathRenderer.render(latex, size: size, display: display) else {
                return Text(verbatim: latex).monospaced().foregroundStyle(Color.subtleText)
            }
            return Text(Image(uiImage: math.image).renderingMode(.template)).baselineOffset(-math.descent)
        case .image(let alt):
            return Text(verbatim: alt.isEmpty ? "[image]" : "[\(alt)]").foregroundStyle(Color.subtleText)
        case .softBreak:
            return Text(verbatim: " ")
        case .lineBreak:
            return Text(verbatim: "\n")
        }
    }

    static func plainText(_ inlines: [MDInline]) -> String {
        inlines.map { node -> String in
            switch node {
            case .text(let string), .code(let string): string
            case .strong(let inner), .emphasis(let inner), .strikethrough(let inner), .link(let inner, _): plainText(inner)
            case .math(let latex, _): latex
            case .image(let alt): alt
            case .softBreak: " "
            case .lineBreak: "\n"
            }
        }.joined()
    }
}

// MARK: - Code

private struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code").font(.caption.weight(.semibold)).foregroundStyle(Color.subtleText)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.brand)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            ScrollView(.horizontal, showsIndicators: false) {
                Text(verbatim: code)
                    .font(.system(.footnote, design: .monospaced))
                    .padding(12)
                    .textSelection(.enabled)
            }
        }
        .background(Color(light: 0xFFFFFF, dark: 0x161618), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.track, lineWidth: 1))
    }
}

// MARK: - Display math

private struct DisplayMathView: View {
    let latex: String
    let size: CGFloat

    var body: some View {
        if let math = MathRenderer.render(latex, size: size, display: true) {
            let formula = Image(uiImage: math.image)
                .renderingMode(.template)
                .foregroundStyle(.primary)
                .accessibilityLabel(latex)
            // Centred when it fits, scrollable when it is wider than the bubble.
            ViewThatFits(in: .horizontal) {
                formula.frame(maxWidth: .infinity)
                ScrollView(.horizontal, showsIndicators: false) { formula }
            }
        } else {
            Text(verbatim: latex).font(.system(.footnote, design: .monospaced)).foregroundStyle(Color.subtleText)
        }
    }
}

// MARK: - Tables

private struct TableBlockView: View {
    let header: [[MDInline]]
    let alignments: [MDAlignment]
    let rows: [[[MDInline]]]
    let mathSize: CGFloat

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { column, cell in
                        cellView(cell, column: column, bold: true)
                            .background(Color.chipFill)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Divider().gridCellUnsizedAxes(.horizontal).gridCellColumns(max(header.count, 1))
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            cellView(cell, column: column, bold: false)
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.track, lineWidth: 1))
        }
    }

    private func cellView(_ cell: [MDInline], column: Int, bold: Bool) -> some View {
        let alignment = alignments.indices.contains(column) ? alignments[column] : .leading
        return InlineText.make(cell, mathSize: mathSize, bold: bold)
            .font(.subheadline)
            .multilineTextAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
            .frame(minWidth: 56, maxWidth: 240, alignment: alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
    }
}
