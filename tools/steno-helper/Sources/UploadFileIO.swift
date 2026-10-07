import CryptoKit
import Darwin
import Foundation

private let maxBytes = 20 * 1_048_576

// Inspect metadata before open: dataless iCloud items can block on hydration.
func locallyReadableRegular(_ dir: Int32, _ name: String) -> Bool {
    var info = stat()
    return fstatat(dir, name, &info, AT_SYMLINK_NOFOLLOW) == 0 &&
        (info.st_mode & S_IFMT) == S_IFREG && (info.st_flags & UInt32(SF_DATALESS)) == 0
}

func uploadReadRegular(_ dir: Int32, _ name: String) -> Data? {
    guard locallyReadableRegular(dir, name) else { return nil }
    let fd = openat(dir, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= maxBytes else { return nil }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let n = read(fd, &buffer, buffer.count)
        if n == 0 { break }
        guard n > 0 else { return nil }
        data.append(buffer, count: n)
        guard data.count <= maxBytes else { return nil }
    }
    return data
}

func uploadSHA256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

// 임시 이름으로 쓴 뒤 rename 한다. 대상 이름이 링크여도 링크 자체만 바뀐다.
func uploadWriteAtomically(_ dir: Int32, _ name: String, _ data: Data, beforeRename: () -> Bool = { true }) -> Bool {
    let temp = ".tmp-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    let fd = openat(dir, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return false }
    let ok = data.withUnsafeBytes { raw -> Bool in
        var offset = 0
        while offset < data.count {
            let n = write(fd, raw.baseAddress!.advanced(by: offset), data.count - offset)
            guard n > 0 else { return false }
            offset += n
        }
        return true
    } && fsync(fd) == 0
    close(fd)
    guard ok, beforeRename(), renameat(dir, temp, dir, name) == 0 else { _ = unlinkat(dir, temp, 0); return false }
    return true
}

// 목록을 끝까지 읽지 못하면 nil. 부분 목록으로 "빠진 노트"를 판단하면 사본을 잘못 지운다.
func uploadListNames(_ dir: Int32) -> [String]? {
    guard let stream = fdopendir(dup(dir)) else { return nil }
    defer { closedir(stream) }
    var names: [String] = []
    while true {
        errno = 0
        guard let entry = readdir(stream) else { return errno == 0 ? names : nil }
        let name = withUnsafePointer(to: &entry.pointee.d_name) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
        }
        names.append(name)
    }
}
