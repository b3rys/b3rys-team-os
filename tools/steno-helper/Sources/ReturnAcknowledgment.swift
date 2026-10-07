import Darwin
import Foundation

// A successful submission acknowledges exactly those bytes, not a later local
// team edit. Sync may replace only an unchanged submitted copy with the merged
// source; newer team edits are rebased on the last submitted version instead.
func acknowledgeReturn(sourcePath: String, file: String, data: Data) -> Bool {
    let sharedPath = URL(fileURLWithPath: sourcePath).deletingLastPathComponent().appendingPathComponent("steno-shared").path
    let shared = canonicalDirectory(sharedPath)
    guard shared >= 0 else { return false }
    defer { close(shared) }
    let bases = childDirectory(shared, ".bases")
    guard bases >= 0 else { return false }
    defer { close(bases) }
    let hash = uploadSHA256(data)
    guard uploadWriteAtomically(bases, hash + ".data", data) else { return false }
    var values: [String: String] = [:]
    var info = stat()
    if fstatat(shared, ".returns.json", &info, AT_SYMLINK_NOFOLLOW) == 0 {
        guard let raw = uploadReadRegular(shared, ".returns.json"),
              let parsed = try? JSONSerialization.jsonObject(with: raw) as? [String: String] else { return false }
        values = parsed
    } else if errno != ENOENT { return false }
    values[file.precomposedStringWithCanonicalMapping] = hash
    guard let raw = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { return false }
    return uploadWriteAtomically(shared, ".returns.json", raw)
}
