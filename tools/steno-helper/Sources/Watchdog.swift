import Darwin

// Prepare and pin the message before installing the async-signal-safe handler.
private let watchdogBytes: [UInt8] = Array("steno-helper: 진척 없이 제한 시간을 넘겨 중단함 (iCloud 내려받기·권한 대기 의심)\n".utf8)
private let watchdogLength = watchdogBytes.count
private let watchdogPointer: UnsafeMutablePointer<UInt8> = {
    let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: watchdogLength)
    watchdogBytes.withUnsafeBufferPointer { pointer.initialize(from: $0.baseAddress!, count: watchdogLength) }
    return pointer
}()

func startWatchdog(_ seconds: UInt32) {
    _ = watchdogPointer // Initialize globals before any signal can arrive.
    signal(SIGALRM) { _ in
        _ = write(STDERR_FILENO, watchdogPointer, watchdogLength)
        _exit(1)
    }
    watchdogSeconds = seconds
    watchdogProgress()
}

// Only arm after the handler is installed; ordinary test builds leave this disabled.
private var watchdogSeconds: UInt32 = 0

func watchdogProgress() {
    guard watchdogSeconds > 0 else { return }
    alarm(watchdogSeconds)
}
