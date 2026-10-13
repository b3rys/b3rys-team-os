import Darwin
import Foundation

func isStenoPart(_ name: String) -> Bool { name.hasSuffix(".steno-part") }

func stenoPartName() -> String { ".\(UUID().uuidString).steno-part" }

// Only remove regular files. Never follow a link or remove a directory.
func cleanupStenoParts(_ dir: Int32) -> Bool {
    let scan = openat(dir, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard scan >= 0 else { return false }
    guard let stream = fdopendir(scan) else { close(scan); return false }
    defer { closedir(stream) }
    while true {
        errno = 0
        guard let entry = readdir(stream) else { return errno == 0 }
        let name = withUnsafePointer(to: &entry.pointee.d_name) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
        }
        guard name.hasPrefix("."), isStenoPart(name) else { continue }
        var info = stat()
        guard fstatat(dir, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return false }
        if (info.st_mode & S_IFMT) == S_IFREG, unlinkat(dir, name, 0) != 0 { return false }
    }
}

// A failed write/fsync/publication leaves no final name and removes its temporary file.
func withStenoPart(_ dir: Int32, _ data: Data, publish: (String) -> Bool) -> Bool {
    let temp = stenoPartName()
    let fd = openat(dir, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return false }
    defer { close(fd); _ = unlinkat(dir, temp, 0) }
    let ok = data.withUnsafeBytes { raw -> Bool in
        var offset = 0
        while offset < data.count {
            let n = write(fd, raw.baseAddress!.advanced(by: offset), data.count - offset)
            guard n > 0 else { return false }
            offset += n
            watchdogProgress()
        }
        return true
    }
    guard ok, fsync(fd) == 0 else { return false }
    guard publish(temp) else { return false }
    watchdogProgress()
    return true
}
