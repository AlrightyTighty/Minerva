//
//  MarkdownModel.swift
//  Minerva
//
//  Turns the assistant's Markdown (plus LaTeX) into a small tree the SwiftUI views render. This file imports
//  `Markdown` but not SwiftUI, because the two export clashing names (`Text`, `Image`, `Link`, `Table`).
//

import Foundation
import Markdown

indirect enum MDInline {
    case text(String)
    case strong([MDInline])
    case emphasis([MDInline])
    case strikethrough([MDInline])
    case code(String)
    case link([MDInline], URL?)
    case math(String, display: Bool)
    case image(alt: String)
    case softBreak
    case lineBreak
}

enum MDAlignment {
    case leading, center, trailing
}

struct MDListItem {
    /// `nil` for a normal item, otherwise whether the task-list box is ticked.
    var checked: Bool?
    var blocks: [MDBlock]
}

indirect enum MDBlock {
    case paragraph([MDInline])
    case heading(level: Int, [MDInline])
    case code(language: String?, String)
    case quote([MDBlock])
    case list(ordered: Bool, start: Int, items: [MDListItem])
    case table(header: [[MDInline]], alignments: [MDAlignment], rows: [[[MDInline]]])
    case rule
    case displayMath(String)
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MDBlock] {
        let extraction = MathExtractor.extract(source)
        let document = Document(parsing: extraction.text)
        return blocks(document.children, math: extraction.spans)
    }

    // MARK: Blocks

    private static func blocks(_ children: MarkupChildren, math: [MathSpan]) -> [MDBlock] {
        children.compactMap { block($0, math: math) }
    }

    private static func block(_ markup: Markup, math: [MathSpan]) -> MDBlock? {
        switch markup {
        case let paragraph as Paragraph:
            let content = inlines(paragraph.children, math: math)
            // A paragraph that is only a display formula is a block of its own, centred.
            if content.count == 1, case .math(let latex, display: true) = content[0] { return .displayMath(latex) }
            return .paragraph(content)
        case let heading as Heading:
            return .heading(level: heading.level, inlines(heading.children, math: math))
        case let code as CodeBlock:
            let language = code.language?.trimmingCharacters(in: .whitespaces)
            return .code(language: (language?.isEmpty ?? true) ? nil : language, code.code.trimmingCharacters(in: .newlines))
        case let quote as BlockQuote:
            return .quote(blocks(quote.children, math: math))
        case let list as UnorderedList:
            return .list(ordered: false, start: 1, items: items(list.listItems, math: math))
        case let list as OrderedList:
            return .list(ordered: true, start: Int(list.startIndex), items: items(list.listItems, math: math))
        case let table as Table:
            return tableBlock(table, math: math)
        case is ThematicBreak:
            return .rule
        case let html as HTMLBlock:
            return .paragraph([.text(html.rawHTML.trimmingCharacters(in: .whitespacesAndNewlines))])
        default:
            let plain = markup.format().trimmingCharacters(in: .whitespacesAndNewlines)
            return plain.isEmpty ? nil : .paragraph([.text(plain)])
        }
    }

    private static func items(_ listItems: some Sequence<ListItem>, math: [MathSpan]) -> [MDListItem] {
        listItems.map { item in
            let checked: Bool? = item.checkbox.map { $0 == .checked }
            return MDListItem(checked: checked, blocks: blocks(item.children, math: math))
        }
    }

    private static func tableBlock(_ table: Table, math: [MathSpan]) -> MDBlock {
        func cells(_ cells: some Sequence<Table.Cell>) -> [[MDInline]] {
            cells.map { inlines($0.children, math: math) }
        }
        let alignments = table.columnAlignments.map { alignment -> MDAlignment in
            switch alignment {
            case .center: .center
            case .right: .trailing
            default: .leading
            }
        }
        return .table(header: cells(table.head.cells), alignments: alignments, rows: table.body.rows.map { cells($0.cells) })
    }

    // MARK: Inlines

    private static func inlines(_ children: MarkupChildren, math: [MathSpan]) -> [MDInline] {
        children.flatMap { inline($0, math: math) }
    }

    private static func inline(_ markup: Markup, math: [MathSpan]) -> [MDInline] {
        switch markup {
        case let text as Markdown.Text:
            return splitMath(text.string, math: math)
        case let strong as Strong:
            return [.strong(inlines(strong.children, math: math))]
        case let emphasis as Emphasis:
            return [.emphasis(inlines(emphasis.children, math: math))]
        case let strike as Strikethrough:
            return [.strikethrough(inlines(strike.children, math: math))]
        case let code as InlineCode:
            return [.code(code.code)]
        case let link as Markdown.Link:
            return [.link(inlines(link.children, math: math), link.destination.flatMap(URL.init(string:)))]
        case let image as Markdown.Image:
            return [.image(alt: image.plainText)]
        case is SoftBreak:
            return [.softBreak]
        case is LineBreak:
            return [.lineBreak]
        case let html as InlineHTML:
            return [.text(html.rawHTML)]
        default:
            return [.text(markup.format())]
        }
    }

    /// Swaps the placeholders left by `MathExtractor` back into math nodes.
    private static func splitMath(_ string: String, math: [MathSpan]) -> [MDInline] {
        guard string.contains(MathExtractor.open) else { return [.text(string)] }
        var result: [MDInline] = []
        var buffer = ""
        var index = string.startIndex
        while index < string.endIndex {
            let character = string[index]
            if character == MathExtractor.open, let close = string[index...].firstIndex(of: MathExtractor.close) {
                let number = string[string.index(after: index)..<close]
                if let id = Int(number), math.indices.contains(id) {
                    if !buffer.isEmpty { result.append(.text(buffer)); buffer = "" }
                    result.append(.math(math[id].latex, display: math[id].display))
                    index = string.index(after: close)
                    continue
                }
            }
            buffer.append(character)
            index = string.index(after: index)
        }
        if !buffer.isEmpty { result.append(.text(buffer)) }
        return result
    }
}

// MARK: - LaTeX extraction

struct MathSpan {
    let latex: String
    let display: Bool
}

/// Finds LaTeX in the raw text and swaps each formula for a placeholder before the Markdown parser sees it,
/// so characters like `_` and `*` inside a formula don't get read as emphasis.
///
/// Recognised: `$$…$$` and `\[…\]` (display), `\(…\)` and `$…$` (inline). Code fences and inline code are left
/// alone, and a `$` that looks like money (`$5`) is not treated as the start of a formula. A formula that hasn't
/// been closed yet, as happens while a reply is streaming, stays as plain text until it is.
enum MathExtractor {
    static let open: Character = "\u{E000}"
    static let close: Character = "\u{E001}"

    static func extract(_ source: String) -> (text: String, spans: [MathSpan]) {
        let chars = Array(source)
        var out = ""
        var spans: [MathSpan] = []
        var i = 0
        var inFence = false

        func find(_ needle: [Character], from start: Int, sameLine: Bool = false) -> Int? {
            guard !needle.isEmpty, start <= chars.count - needle.count else { return nil }
            var j = start
            while j <= chars.count - needle.count {
                if sameLine, chars[j] == "\n" { return nil }
                if chars[j] == needle[0], Array(chars[j..<(j + needle.count)]) == needle { return j }
                j += 1
            }
            return nil
        }

        func isBlankSoFar() -> Bool {
            let line = out.split(separator: "\n", omittingEmptySubsequences: false).last ?? ""
            return line.allSatisfy { $0 == " " || $0 == "\t" }
        }

        func emit(_ latex: String, display: Bool, end: Int) {
            let cleaned = latex.trimmingCharacters(in: .whitespacesAndNewlines)
            let id = spans.count
            spans.append(MathSpan(latex: cleaned, display: display))
            let token = "\(open)\(id)\(close)"
            // A formula that starts its own line becomes its own paragraph, so it can be centred.
            var rest = end
            while rest < chars.count, chars[rest] == " " || chars[rest] == "\t" { rest += 1 }
            let endsLine = rest >= chars.count || chars[rest] == "\n"
            if display, isBlankSoFar(), endsLine {
                let line = out.split(separator: "\n", omittingEmptySubsequences: false).last ?? ""
                // Indented formulas (inside a list item) keep their place; wrapping them would end the list.
                out += line.isEmpty ? "\n\n\(token)\n\n" : token
            } else {
                out += token
            }
        }

        while i < chars.count {
            if i == 0 || chars[i - 1] == "\n" {
                var lineEnd = i
                while lineEnd < chars.count, chars[lineEnd] != "\n" { lineEnd += 1 }
                let line = String(chars[i..<lineEnd]).trimmingCharacters(in: .whitespaces)
                if line.hasPrefix("```") || line.hasPrefix("~~~") { inFence.toggle() }
                if inFence || line.hasPrefix("```") || line.hasPrefix("~~~") {
                    out += String(chars[i..<min(lineEnd + 1, chars.count)])
                    i = min(lineEnd + 1, chars.count)
                    continue
                }
            }

            let c = chars[i]

            if c == "`" {
                var run = 0
                while i + run < chars.count, chars[i + run] == "`" { run += 1 }
                let fence = Array(repeating: Character("`"), count: run)
                if let end = find(fence, from: i + run) {
                    out += String(chars[i..<(end + run)])
                    i = end + run
                } else {
                    out += String(fence)
                    i += run
                }
                continue
            }

            if c == "\\", i + 1 < chars.count {
                let next = chars[i + 1]
                if next == "[", let end = find(["\\", "]"], from: i + 2) {
                    emit(String(chars[(i + 2)..<end]), display: true, end: end + 2)
                    i = end + 2
                    continue
                }
                if next == "(", let end = find(["\\", ")"], from: i + 2) {
                    emit(String(chars[(i + 2)..<end]), display: false, end: end + 2)
                    i = end + 2
                    continue
                }
                out.append(c)
                out.append(next)
                i += 2
                continue
            }

            if c == "$" {
                if i + 1 < chars.count, chars[i + 1] == "$" {
                    if let end = find(["$", "$"], from: i + 2), end > i + 2 {
                        emit(String(chars[(i + 2)..<end]), display: true, end: end + 2)
                        i = end + 2
                        continue
                    }
                } else if i + 1 < chars.count {
                    let next = chars[i + 1]
                    if !next.isWhitespace, !next.isNumber, let end = find(["$"], from: i + 1, sameLine: true),
                       end > i + 1, !chars[end - 1].isWhitespace,
                       end + 1 >= chars.count || !chars[end + 1].isNumber {
                        emit(String(chars[(i + 1)..<end]), display: false, end: end + 1)
                        i = end + 1
                        continue
                    }
                }
            }

            out.append(c)
            i += 1
        }
        return (out, spans)
    }
}
