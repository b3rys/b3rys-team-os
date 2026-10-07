import Foundation

// Same deterministic line/hunk rules as Steno web/src/line-merge.js.
enum LineMergeError: Error { case tooLarge }
private struct LineHunk {
    let start: Int
    let end: Int
    let replacement: [String]
}
private func exactLine(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
private func lineHunks(_ base: [String], _ changed: [String]) throws -> [LineHunk] {
    var prefix = 0
    while prefix < min(base.count, changed.count), exactLine(base[prefix], changed[prefix]) { prefix += 1 }
    var suffix = 0
    while suffix < min(base.count, changed.count) - prefix,
          exactLine(base[base.count - suffix - 1], changed[changed.count - suffix - 1]) { suffix += 1 }
    let a = Array(base[prefix..<(base.count - suffix)])
    let b = Array(changed[prefix..<(changed.count - suffix)])
    let n = a.count, m = b.count
    if n == 0 && m == 0 { return [] }
    if n == 0 || m == 0 { return [LineHunk(start: prefix, end: prefix + n, replacement: b)] }
    guard n <= 4_000_000 / m else { throw LineMergeError.tooLarge }
    let width = m + 1
    var table = [UInt32](repeating: 0, count: (n + 1) * width)
    for i in stride(from: n - 1, through: 0, by: -1) {
        for j in stride(from: m - 1, through: 0, by: -1) {
            table[i * width + j] = exactLine(a[i], b[j]) ? table[(i + 1) * width + j + 1] + 1 :
                max(table[(i + 1) * width + j], table[i * width + j + 1])
        }
    }
    var result: [LineHunk] = []
    var i = 0, j = 0, start: Int?, replacement: [String] = []
    func flush() {
        if let start {
            if i - start == replacement.count && replacement.count > 1 {
                for offset in replacement.indices {
                    result.append(LineHunk(start: prefix + start + offset, end: prefix + start + offset + 1, replacement: [replacement[offset]]))
                }
            } else { result.append(LineHunk(start: prefix + start, end: prefix + i, replacement: replacement)) }
        }
        start = nil; replacement = []
    }
    while i < n || j < m {
        if i < n && j < m && exactLine(a[i], b[j]) { flush(); i += 1; j += 1 }
        else if i < n && (j == m || table[(i + 1) * width + j] >= table[i * width + j + 1]) {
            if start == nil { start = i }; i += 1
        } else {
            if start == nil { start = i }; replacement.append(b[j]); j += 1
        }
    }
    flush()
    return result
}
private func overlaps(_ a: LineHunk, _ b: LineHunk) -> Bool {
    if a.start == a.end && b.start == b.end { return a.start == b.start }
    if a.start == a.end { return b.start < a.start && a.start < b.end }
    if b.start == b.end { return a.start < b.start && b.start < a.end }
    return max(a.start, b.start) < min(a.end, b.end)
}

func mergeLines(base: String, current: String, proposed: String) throws -> String {
    func lf(_ value: String) -> String { value.replacingOccurrences(of: "\r\n", with: "\n") }
    let base = lf(base), current = lf(current), proposed = lf(proposed)
    if exactLine(current, base) { return proposed }
    if exactLine(proposed, base) || exactLine(current, proposed) { return current }
    let lines = base.components(separatedBy: "\n")
    let currentHunks = try lineHunks(lines, current.components(separatedBy: "\n"))
    let proposedHunks = try lineHunks(lines, proposed.components(separatedBy: "\n"))
    let retained = currentHunks.filter { old in !proposedHunks.contains { overlaps(old, $0) } }
    let all = (retained + proposedHunks).sorted { a, b in
        a.start != b.start ? a.start < b.start : a.end < b.end
    }
    var output: [String] = [], position = 0
    for hunk in all {
        output.append(contentsOf: lines[position..<hunk.start])
        output.append(contentsOf: hunk.replacement)
        position = hunk.end
    }
    output.append(contentsOf: lines[position...])
    return output.joined(separator: "\n")
}
