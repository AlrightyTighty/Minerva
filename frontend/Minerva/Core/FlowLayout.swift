//
//  FlowLayout.swift
//  Minerva
//

import SwiftUI

/// Lays children out in rows, wrapping to a new row when one runs out of width. Used for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, origin) in result.origins.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: result.sizes[index].width, height: result.sizes[index].height)
            )
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint], sizes: [CGSize]) {
        var origins: [CGPoint] = []
        var sizes: [CGSize] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var maxX: CGFloat = 0
        for subview in subviews {
            // Measure within the available width, so one long child shrinks (or truncates) instead of
            // stretching the whole layout past the edge of the screen.
            var size = subview.sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
            if width.isFinite { size.width = min(size.width, width) }
            sizes.append(size)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + rowHeight), origins, sizes)
    }
}
