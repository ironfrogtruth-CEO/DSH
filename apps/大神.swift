// 大神 · 原生桌面应用 — DeepSeek Harness 界面外壳
// 双击启动: 确保 dsh web 服务运行 → 弹出原生窗口加载 DSH 界面(不开浏览器)
// 编译: swiftc -O -o 大神 大神.swift -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation
// ⚠️ 本机 DSH shell 跑在 Rosetta(x86_64), 上面默认命令会编出 Intel 二进制并触发 macOS "即将结束 Intel App 支持" 警告。
// ✅ 必须用显式 arm64 目标: swiftc -O -target arm64-apple-macos13.0 -o 大神 大神.swift -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation
// 速记员编译还需要: -framework ScreenCaptureKit -framework CoreMedia -framework AudioToolbox
import Cocoa
import WebKit
import Speech
import AVFoundation
import CoreMedia
import AudioToolbox
import ScreenCaptureKit

let PORT = 3080
let UI_URL = "http://127.0.0.1:\(PORT)"
let ENSURE_SCRIPT = (("~" as NSString).expandingTildeInPath) + "/.dsh/scripts/enable-host"
let STOP_SCRIPT = (("~" as NSString).expandingTildeInPath) + "/.dsh/scripts/disable-host"
let BACKGROUND_LAUNCH_SENTINEL = NSHomeDirectory() + "/.dsh/private/background-launch"
let BACKGROUND_LAUNCH_MAX_AGE: TimeInterval = 5 * 60
let DINGTALK_SUBSCRIPTION_ADMIN_TOKEN = NSHomeDirectory() + "/.dsh/private/dingtalk-subscriptions/native-admin-token"
let DINGTALK_SUBSCRIPTION_ADMIN_PATH = "/api/dsh-dingtalk/subscriptions/admin"
let DINGTALK_SUBSCRIPTION_ADMIN_MAX_RESPONSE_BYTES = 1_048_576

// 速记员的桥接合同固定输出 16 kHz / mono / signed little-endian PCM16。
let STENOGRAPHER_SAMPLE_RATE: Double = 16_000
let STENOGRAPHER_CHANNEL_COUNT: AVAudioChannelCount = 1
let STENOGRAPHER_CHUNK_FRAMES = 8_000 // 500 ms, 16 KB
let STENOGRAPHER_MAX_PENDING_UPLOADS = 24
let STENOGRAPHER_MAX_CHUNK_BYTES = 1_048_576

func stenographerNowMs() -> Int64 {
    return Int64(Date().timeIntervalSince1970 * 1_000.0)
}

struct StenographerChunk {
    let sessionId: String
    let uploadUrl: URL
    let token: String
    let source: String
    let seq: Int
    let capturedAtMs: Int64
    let data: Data
}

// Serialises uploads so seq order is preserved per source.  The pending list
// is deliberately bounded; a slow/dead Host reports an explicit event instead
// of allowing an unbounded audio-memory queue to grow for hours.
final class StenographerUploadQueue {
    typealias EventHandler = ([String: Any]) -> Void

    private let stateQueue = DispatchQueue(label: "local.dsh.stenographer.upload")
    private let urlSession: URLSession
    private let maxPending: Int
    private let eventHandler: EventHandler
    private var pending: [StenographerChunk] = []
    private var inFlight = false
    private var finishing = false
    private var finishHandler: (() -> Void)?

    init(maxPending: Int = STENOGRAPHER_MAX_PENDING_UPLOADS, eventHandler: @escaping EventHandler) {
        self.maxPending = max(1, maxPending)
        self.eventHandler = eventHandler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 15
        configuration.httpMaximumConnectionsPerHost = 1
        self.urlSession = URLSession(configuration: configuration)
    }

    func enqueue(_ chunk: StenographerChunk) {
        guard chunk.data.count <= STENOGRAPHER_MAX_CHUNK_BYTES else {
            report(code: "chunk_too_large", message: "PCM chunk exceeds the upload contract", chunk: chunk)
            return
        }
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            guard !self.finishing else {
                self.report(code: "queue_closed", message: "Upload queue is already flushing", chunk: chunk)
                return
            }
            guard self.pending.count < self.maxPending else {
                self.report(code: "upload_queue_overflow", message: "Upload queue is full; audio chunk was dropped", chunk: chunk)
                return
            }
            self.pending.append(chunk)
            self.pump()
        }
    }

    func finish(completion: (() -> Void)? = nil) {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.finishing = true
            self.finishHandler = completion
            self.pump()
        }
    }

    func cancel() {
        stateQueue.async { [weak self] in
            guard let self = self else { return }
            self.pending.removeAll(keepingCapacity: false)
            self.finishing = true
            self.finishHandler = nil
        }
    }

    private func pump() {
        guard !inFlight else { return }
        guard !pending.isEmpty else {
            if finishing {
                let handler = finishHandler
                finishHandler = nil
                handler?()
            }
            return
        }

        let chunk = pending.removeFirst()
        guard var components = URLComponents(url: chunk.uploadUrl, resolvingAgainstBaseURL: false) else {
            report(code: "invalid_upload_url", message: "Upload URL cannot be represented", chunk: chunk)
            pump()
            return
        }
        var query = components.queryItems ?? []
        query.append(URLQueryItem(name: "source", value: chunk.source))
        query.append(URLQueryItem(name: "seq", value: String(chunk.seq)))
        query.append(URLQueryItem(name: "capturedAtMs", value: String(chunk.capturedAtMs)))
        components.queryItems = query
        guard let requestURL = components.url else {
            report(code: "invalid_upload_url", message: "Upload URL query could not be encoded", chunk: chunk)
            pump()
            return
        }

        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(chunk.token, forHTTPHeaderField: "X-Stenographer-Token")
        request.httpBody = chunk.data
        inFlight = true
        urlSession.dataTask(with: request) { [weak self] _, response, error in
            guard let self = self else { return }
            self.stateQueue.async {
                self.inFlight = false
                if let error = error {
                    self.report(code: "upload_failed", message: error.localizedDescription, chunk: chunk)
                } else if let status = (response as? HTTPURLResponse)?.statusCode, !(200..<300).contains(status) {
                    self.report(code: "upload_http_error", message: "Host returned HTTP \(status)", chunk: chunk)
                } else if response == nil {
                    self.report(code: "upload_failed", message: "Host returned no response", chunk: chunk)
                }
                self.pump()
            }
        }.resume()
    }

    private func report(code: String, message: String, chunk: StenographerChunk) {
        eventHandler([
            "schema": "stenographer_native_event.v1",
            "kind": "error",
            "state": "degraded",
            "action": "upload",
            "status": "upload_failed",
            "errorCode": code,
            "message": message,
            "error": ["code": code, "message": message],
            "sessionId": chunk.sessionId,
            "source": chunk.source,
            "seq": chunk.seq,
            "capturedAtMs": chunk.capturedAtMs,
            "recoverable": true
        ])
    }
}

// Accumulates small callback buffers into bounded 500 ms chunks.  The
// accumulator is only touched by StenographerController's serial control queue.
struct StenographerChunkAccumulator {
    private var bytes = Data()
    private var firstCapturedAtMs: Int64?

    mutating func append(_ data: Data, capturedAtMs: Int64) -> [(Data, Int64)] {
        guard !data.isEmpty else { return [] }
        if bytes.isEmpty { firstCapturedAtMs = capturedAtMs }
        bytes.append(data)
        var chunks: [(Data, Int64)] = []
        let chunkBytes = STENOGRAPHER_CHUNK_FRAMES * MemoryLayout<Int16>.size
        while bytes.count >= chunkBytes {
            let chunk = Data(bytes.prefix(chunkBytes))
            let timestamp = firstCapturedAtMs ?? capturedAtMs
            chunks.append((chunk, timestamp))
            bytes.removeFirst(chunkBytes)
            if bytes.isEmpty {
                firstCapturedAtMs = nil
            } else {
                firstCapturedAtMs = timestamp + Int64(Double(STENOGRAPHER_CHUNK_FRAMES) * 1_000.0 / STENOGRAPHER_SAMPLE_RATE)
            }
        }
        return chunks
    }

    mutating func flush() -> (Data, Int64)? {
        guard !bytes.isEmpty else { return nil }
        let result = (bytes, firstCapturedAtMs ?? stenographerNowMs())
        bytes.removeAll(keepingCapacity: false)
        firstCapturedAtMs = nil
        return result
    }

    mutating func reset() {
        bytes.removeAll(keepingCapacity: false)
        firstCapturedAtMs = nil
    }
}

// AVAudioEngine input formats are hardware-dependent.  AVAudioConverter keeps
// its resampler state between callbacks and guarantees the bridge's PCM16
// format without forcing the hardware to reconfigure to 16 kHz.
final class StenographerPCM16Normalizer {
    private let targetFormat: AVAudioFormat
    private var converter: AVAudioConverter?
    private var sourceSignature: String?

    init() {
        targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: STENOGRAPHER_SAMPLE_RATE,
            channels: STENOGRAPHER_CHANNEL_COUNT,
            interleaved: true
        )!
    }

    func convert(_ input: AVAudioPCMBuffer) -> Data? {
        guard input.frameLength > 0 else { return nil }
        let format = input.format
        let signature = "\(format.sampleRate):\(format.channelCount):\(format.commonFormat.rawValue):\(format.isInterleaved)"
        if sourceSignature != signature {
            converter = AVAudioConverter(from: format, to: targetFormat)
            sourceSignature = signature
        }

        let ratio = STENOGRAPHER_SAMPLE_RATE / max(1.0, format.sampleRate)
        let capacity = max(1, AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 64)
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity),
              let converter = converter else { return nil }

        var provided = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if provided {
                inputStatus.pointee = .noDataNow
                return nil
            }
            provided = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status == .haveData || status == .inputRanDry || output.frameLength > 0,
              let channelData = output.int16ChannelData else { return nil }
        let byteCount = Int(output.frameLength) * MemoryLayout<Int16>.size
        return Data(bytes: channelData[0], count: byteCount)
    }
}

final class StenographerMicrophoneCapture {
    private let engine = AVAudioEngine()
    private let normalizer = StenographerPCM16Normalizer()
    private let audioHandler: (Data, Int64) -> Void
    private let errorHandler: (String, String) -> Void
    private var tapInstalled = false

    init(audioHandler: @escaping (Data, Int64) -> Void, errorHandler: @escaping (String, String) -> Void) {
        self.audioHandler = audioHandler
        self.errorHandler = errorHandler
    }

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "local.dsh.stenographer", code: 1001, userInfo: [NSLocalizedDescriptionKey: "No microphone input format is available"])
        }
        if tapInstalled { input.removeTap(onBus: 0); tapInstalled = false }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            guard let pcm = self.normalizer.convert(buffer), !pcm.isEmpty else {
                self.errorHandler("microphone_capture_error", "Could not normalize a microphone buffer to PCM16")
                return
            }
            self.audioHandler(pcm, stenographerNowMs())
        }
        tapInstalled = true
        engine.prepare()
        do {
            try engine.start()
        } catch {
            if tapInstalled { input.removeTap(onBus: 0); tapInstalled = false }
            throw error
        }
    }

    func stop() {
        let input = engine.inputNode
        if tapInstalled {
            input.removeTap(onBus: 0)
            tapInstalled = false
        }
        if engine.isRunning { engine.stop() }
    }
}

// ScreenCaptureKit delivers an AudioBufferList.  It is configured for 16 kHz
// mono and converted defensively from float/int PCM so the native bridge still
// enforces the exact PCM16 contract if the OS supplies a different packing.
final class StenographerSystemCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let audioHandler: (Data, Int64) -> Void
    private let startedHandler: () -> Void
    private let errorHandler: (String, String) -> Void
    private let outputQueue = DispatchQueue(label: "local.dsh.stenographer.system-audio", qos: .userInitiated)
    private var stream: SCStream?
    private var stopping = false

    init(audioHandler: @escaping (Data, Int64) -> Void, startedHandler: @escaping () -> Void, errorHandler: @escaping (String, String) -> Void) {
        self.audioHandler = audioHandler
        self.startedHandler = startedHandler
        self.errorHandler = errorHandler
    }

    func start() {
        guard #available(macOS 13.0, *) else {
            errorHandler("system_audio_unavailable", "ScreenCaptureKit audio requires macOS 13 or newer")
            return
        }
        if !CGPreflightScreenCaptureAccess() {
            let granted = CGRequestScreenCaptureAccess()
            if !granted {
                errorHandler("system_audio_permission_denied", "Screen Recording permission is required for system audio")
                return
            }
        }
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, error in
            guard let self = self else { return }
            guard let content = content, let display = content.displays.first else {
                self.errorHandler("system_audio_unavailable", error?.localizedDescription ?? "No capturable display is available")
                return
            }
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.width = 2
            configuration.height = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            configuration.queueDepth = 3
            configuration.capturesAudio = true
            configuration.sampleRate = Int(STENOGRAPHER_SAMPLE_RATE)
            configuration.channelCount = Int(STENOGRAPHER_CHANNEL_COUNT)
            configuration.excludesCurrentProcessAudio = true
            let newStream = SCStream(filter: filter, configuration: configuration, delegate: self)
            do {
                try newStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.outputQueue)
            } catch {
                self.errorHandler("system_audio_start_failed", error.localizedDescription)
                return
            }
            self.stream = newStream
            self.stopping = false
            newStream.startCapture { [weak self] error in
                guard let self = self else { return }
                if let error = error {
                    self.errorHandler("system_audio_start_failed", error.localizedDescription)
                } else {
                    self.startedHandler()
                }
            }
        }
    }

    func stop(completion: (() -> Void)? = nil) {
        guard let current = stream else {
            completion?()
            return
        }
        guard !stopping else {
            completion?()
            return
        }
        stopping = true
        current.stopCapture { [weak self] error in
            self?.stream = nil
            if let error = error, self?.stopping == true {
                self?.errorHandler("system_audio_stop_failed", error.localizedDescription)
            }
            completion?()
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sampleBuffer), let data = pcm16Data(from: sampleBuffer), !data.isEmpty else { return }
        audioHandler(data, stenographerNowMs())
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        errorHandler("system_audio_capture_error", error.localizedDescription)
    }

    private func pcm16Data(from sampleBuffer: CMSampleBuffer) -> Data? {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else { return nil }
        let asbd = asbdPointer.pointee
        guard asbd.mSampleRate > 0, asbd.mChannelsPerFrame > 0 else { return nil }
        var listSize = 0
        let sizeStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &listSize,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: nil
        )
        guard sizeStatus == noErr, listSize > 0 else { return nil }
        let rawBufferList = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { rawBufferList.deallocate() }
        let bufferListPointer = rawBufferList.bindMemory(to: AudioBufferList.self, capacity: 1)
        var retainedBlockBuffer: CMBlockBuffer?
        let listStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &listSize,
            bufferListOut: bufferListPointer,
            bufferListSize: listSize,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &retainedBlockBuffer
        )
        guard listStatus == noErr else { return nil }
        let buffers = UnsafeMutableAudioBufferListPointer(bufferListPointer)
        let channels = max(1, Int(asbd.mChannelsPerFrame))
        let bytesPerSample = max(1, Int(asbd.mBitsPerChannel) / 8)
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isSigned = (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        guard isFloat || isSigned, bytesPerSample <= 8 else { return nil }

        let frameCount: Int
        if isNonInterleaved || buffers.count > 1 {
            frameCount = buffers.first.map { Int($0.mDataByteSize) / bytesPerSample } ?? 0
        } else {
            frameCount = buffers.first.map { Int($0.mDataByteSize) / max(bytesPerSample * channels, 1) } ?? 0
        }
        guard frameCount > 0 else { return nil }
        var result = Data(count: frameCount * MemoryLayout<Int16>.size)
        result.withUnsafeMutableBytes { destination in
            guard let destination = destination.baseAddress else { return }
            for frame in 0..<frameCount {
                var mixed: Float = 0
                var contributingChannels = 0
                if isNonInterleaved || buffers.count > 1 {
                    for channel in 0..<min(channels, buffers.count) {
                        let buffer = buffers[channel]
                        guard let data = buffer.mData else { continue }
                        let offset = frame * bytesPerSample
                        mixed += sampleValue(data: data, offset: offset, bytesPerSample: bytesPerSample, isFloat: isFloat, isSigned: isSigned, bitsPerChannel: Int(asbd.mBitsPerChannel))
                        contributingChannels += 1
                    }
                } else if let buffer = buffers.first, let data = buffer.mData {
                    for channel in 0..<channels {
                        let offset = frame * bytesPerSample * channels + channel * bytesPerSample
                        mixed += sampleValue(data: data, offset: offset, bytesPerSample: bytesPerSample, isFloat: isFloat, isSigned: isSigned, bitsPerChannel: Int(asbd.mBitsPerChannel))
                        contributingChannels += 1
                    }
                }
                if contributingChannels > 0 { mixed /= Float(contributingChannels) }
                let clamped = max(-1.0, min(1.0, mixed))
                let integer = clamped <= -1.0 ? Int16.min : Int16(clamped * Float(Int16.max))
                let bits = UInt16(bitPattern: integer).littleEndian
                destination.storeBytes(of: bits, toByteOffset: frame * 2, as: UInt16.self)
            }
        }
        return result
    }

    private func sampleValue(data: UnsafeMutableRawPointer, offset: Int, bytesPerSample: Int, isFloat: Bool, isSigned: Bool, bitsPerChannel: Int) -> Float {
        if isFloat && bytesPerSample == 4 {
            var value: Float = 0
            memcpy(&value, data.advanced(by: offset), 4)
            return value
        }
        if isFloat && bytesPerSample == 8 {
            var value: Double = 0
            memcpy(&value, data.advanced(by: offset), 8)
            return Float(value)
        }
        guard isSigned else { return 0 }
        if bytesPerSample == 2 {
            var value: Int16 = 0
            memcpy(&value, data.advanced(by: offset), 2)
            return Float(value) / Float(Int16.max)
        }
        if bytesPerSample == 4 {
            var value: Int32 = 0
            memcpy(&value, data.advanced(by: offset), 4)
            return Float(value) / Float(Int32.max)
        }
        if bytesPerSample == 1 {
            var value: Int8 = 0
            memcpy(&value, data.advanced(by: offset), 1)
            return Float(value) / Float(Int8.max)
        }
        // Packed widths other than the common 8/16/32-bit PCM are not emitted.
        _ = bitsPerChannel
        return 0
    }
}

struct StenographerStartConfig {
    let sessionId: String
    let source: String
    let uploadUrl: URL
    let uploadToken: String
    let sampleRate: Int

    var sources: [String] {
        source == "both" ? ["microphone", "system"] : [source]
    }
}

final class StenographerController {
    typealias EventHandler = ([String: Any]) -> Void

    private let controlQueue = DispatchQueue(label: "local.dsh.stenographer.control", qos: .userInitiated)
    private let eventHandler: EventHandler
    private var sessionId: String?
    private var config: StenographerStartConfig?
    private var paused = false
    private var stopping = false
    private var pendingAction = "start"
    private var requestedSources = Set<String>()
    private var startedSources = Set<String>()
    private var nextSeq: [String: Int] = ["microphone": 0, "system": 0]
    private var accumulators: [String: StenographerChunkAccumulator] = [
        "microphone": StenographerChunkAccumulator(),
        "system": StenographerChunkAccumulator()
    ]
    private var uploadQueue: StenographerUploadQueue?
    private var microphoneCapture: StenographerMicrophoneCapture?
    private var systemCapture: StenographerSystemCapture?

    init(eventHandler: @escaping EventHandler) {
        self.eventHandler = eventHandler
    }

    var isActive: Bool {
        return controlQueue.sync { sessionId != nil }
    }

    func handleMessage(_ body: Any) {
        guard let message = parseDictionary(body), let action = message["action"] as? String else {
            emitError(action: "unknown", sessionId: nil, code: "invalid_request", message: "stenographer expects a JSON object with action")
            return
        }
        switch action {
        case "start":
            guard let config = parseStartConfig(message) else {
                emitError(action: action, sessionId: message["sessionId"] as? String, code: "invalid_request", message: "start requires sessionId, source, uploadUrl, uploadToken and sampleRate=16000")
                return
            }
            controlQueue.async { [weak self] in self?.start(config) }
        case "pause", "resume", "stop":
            let id = message["sessionId"] as? String
            controlQueue.async { [weak self] in self?.handleLifecycle(action: action, sessionId: id) }
        default:
            emitError(action: action, sessionId: message["sessionId"] as? String, code: "unsupported_action", message: "Unsupported stenographer action")
        }
    }

    // Called synchronously during application termination so capture taps are
    // detached before the native process exits. The interrupted event is best
    // effort; local Host persistence remains the source of truth for recovery.
    func interruptForTermination() {
        controlQueue.sync {
            guard let id = sessionId else { return }
            emit([
                "schema": "stenographer_native_event.v1",
                "kind": "state",
                "action": "interrupt",
                "status": "interrupted",
                "state": "interrupted",
                "sessionId": id,
                "capturedAtMs": stenographerNowMs(),
                "recoverable": true
            ])
            stopping = true
            microphoneCapture?.stop()
            systemCapture?.stop()
            flushAccumulators()
            uploadQueue?.finish()
            microphoneCapture = nil
            systemCapture = nil
            sessionId = nil
            config = nil
        }
    }

    private func start(_ startConfig: StenographerStartConfig) {
        guard sessionId == nil else {
            emitError(action: "start", sessionId: startConfig.sessionId, code: "session_already_active", message: "A stenographer session is already active")
            return
        }
        sessionId = startConfig.sessionId
        config = startConfig
        paused = false
        stopping = false
        pendingAction = "start"
        requestedSources = Set(startConfig.sources)
        startedSources.removeAll()
        nextSeq = ["microphone": 0, "system": 0]
        accumulators["microphone"]?.reset()
        accumulators["system"]?.reset()
        uploadQueue = StenographerUploadQueue { [weak self] payload in self?.emit(payload) }
        emitState(action: "start", status: "starting", state: "starting")
        if requestedSources.contains("microphone") {
            requestMicrophonePermission(for: startConfig.sessionId)
        } else {
            beginSystemIfNeeded(for: startConfig.sessionId)
        }
    }

    private func requestMicrophonePermission(for id: String) {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            beginMicrophone(for: id)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                self?.controlQueue.async {
                    guard let self = self, self.sessionId == id else { return }
                    if granted { self.beginMicrophone(for: id) }
                    else { self.failStart(source: "microphone", code: "microphone_permission_denied", message: "Microphone permission was denied") }
                }
            }
        case .denied, .restricted:
            failStart(source: "microphone", code: "microphone_permission_denied", message: "Microphone permission is denied or restricted")
        @unknown default:
            failStart(source: "microphone", code: "microphone_permission_denied", message: "Microphone permission status is unknown")
        }
    }

    private func beginMicrophone(for id: String) {
        guard sessionId == id, let currentConfig = config else { return }
        let capture = StenographerMicrophoneCapture(
            audioHandler: { [weak self] data, timestamp in self?.acceptAudio(source: "microphone", data: data, capturedAtMs: timestamp, sessionId: id) },
            errorHandler: { [weak self] code, message in
                self?.controlQueue.async {
                    guard let self = self, self.sessionId == id, !self.stopping else { return }
                    self.failActive(source: "microphone", code: code, message: message)
                }
            }
        )
        do {
            try capture.start()
        } catch {
            failStart(source: "microphone", code: "microphone_start_failed", message: error.localizedDescription)
            return
        }
        microphoneCapture = capture
        startedSources.insert("microphone")
        if requestedSources.contains("system") {
            beginSystemIfNeeded(for: currentConfig.sessionId)
        } else {
            completeStartIfReady()
        }
    }

    private func beginSystemIfNeeded(for id: String) {
        guard sessionId == id, !startedSources.contains("system") else {
            completeStartIfReady()
            return
        }
        guard #available(macOS 13.0, *) else {
            failStart(source: "system", code: "system_audio_unavailable", message: "ScreenCaptureKit audio requires macOS 13 or newer")
            return
        }
        let capture = StenographerSystemCapture(
            audioHandler: { [weak self] data, timestamp in self?.acceptAudio(source: "system", data: data, capturedAtMs: timestamp, sessionId: id) },
            startedHandler: { [weak self] in
                self?.controlQueue.async {
                    guard let self = self, self.sessionId == id, !self.stopping else { return }
                    self.startedSources.insert("system")
                    self.completeStartIfReady()
                }
            },
            errorHandler: { [weak self] code, message in
                self?.controlQueue.async {
                    guard let self = self, self.sessionId == id, !self.stopping else { return }
                    self.failStart(source: "system", code: code, message: message)
                }
            }
        )
        systemCapture = capture
        capture.start()
    }

    private func completeStartIfReady() {
        guard !requestedSources.isEmpty, startedSources == requestedSources, !stopping else { return }
        let action = pendingAction
        pendingAction = "start"
        emitState(action: action, status: action == "resume" ? "resumed" : "started", state: "recording")
    }

    private func handleLifecycle(action: String, sessionId id: String?) {
        guard let currentId = sessionId, id == nil || id == currentId else {
            emitError(action: action, sessionId: id, code: "session_not_found", message: "No matching active stenographer session")
            return
        }
        switch action {
        case "pause": pause(currentId)
        case "resume": resume(currentId)
        case "stop": stop(currentId)
        default: break
        }
    }

    private func pause(_ id: String) {
        guard !paused, !stopping else { return }
        paused = true
        microphoneCapture?.stop()
        systemCapture?.stop()
        flushAccumulators()
        emitState(action: "pause", status: "paused", state: "paused", sessionId: id)
    }

    private func resume(_ id: String) {
        guard paused, !stopping, let currentConfig = config else { return }
        paused = false
        startedSources.removeAll()
        pendingAction = "resume"
        emitState(action: "resume", status: "resuming", state: "starting", sessionId: id)
        if requestedSources.contains("microphone") {
            beginMicrophone(for: id)
        } else {
            beginSystemIfNeeded(for: currentConfig.sessionId)
        }
    }

    private func stop(_ id: String) {
        guard !stopping else { return }
        stopping = true
        microphoneCapture?.stop()
        systemCapture?.stop()
        flushAccumulators()
        // The Web panel already enters its stopping phase when it posts stop.
        // Emit only after the bounded queue has drained so finalization cannot
        // race an in-flight audio upload.
        let queue = uploadQueue
        queue?.finish { [weak self] in
            self?.controlQueue.async {
                guard let self = self, self.sessionId == id else { return }
                self.emitState(action: "stop", status: "stopped", state: "stopped", sessionId: id)
                self.emitState(action: "stop", status: "idle", state: "idle", sessionId: id)
                self.microphoneCapture = nil
                self.systemCapture = nil
                self.uploadQueue = nil
                self.sessionId = nil
                self.config = nil
                self.requestedSources.removeAll()
                self.startedSources.removeAll()
                self.stopping = false
                self.paused = false
            }
        }
    }

    private func failStart(source: String, code: String, message: String) {
        guard let id = sessionId else { return }
        microphoneCapture?.stop()
        systemCapture?.stop()
        uploadQueue?.cancel()
        emitError(action: "start", sessionId: id, source: source, code: code, message: message)
        emitState(action: "start", status: "idle", state: "idle", sessionId: id)
        microphoneCapture = nil
        systemCapture = nil
        uploadQueue = nil
        sessionId = nil
        config = nil
        requestedSources.removeAll()
        startedSources.removeAll()
    }

    private func failActive(source: String, code: String, message: String) {
        guard let id = sessionId else { return }
        stopping = true
        microphoneCapture?.stop()
        systemCapture?.stop()
        flushAccumulators()
        emitError(action: "capture", sessionId: id, source: source, code: code, message: message)
        emitState(action: "capture", status: "idle", state: "idle", sessionId: id)
        uploadQueue?.finish()
        microphoneCapture = nil
        systemCapture = nil
        uploadQueue = nil
        sessionId = nil
        config = nil
    }

    private func acceptAudio(source: String, data: Data, capturedAtMs: Int64, sessionId id: String) {
        controlQueue.async { [weak self] in
            guard let self = self, self.sessionId == id, !self.paused, !self.stopping, var accumulator = self.accumulators[source] else { return }
            let chunks = accumulator.append(data, capturedAtMs: capturedAtMs)
            self.accumulators[source] = accumulator
            for (chunkData, timestamp) in chunks { self.enqueue(source: source, data: chunkData, capturedAtMs: timestamp) }
        }
    }

    private func flushAccumulators() {
        for source in ["microphone", "system"] {
            guard var accumulator = accumulators[source] else { continue }
            if let (data, timestamp) = accumulator.flush() { enqueue(source: source, data: data, capturedAtMs: timestamp) }
            accumulators[source] = accumulator
        }
    }

    private func enqueue(source: String, data: Data, capturedAtMs: Int64) {
        guard let currentConfig = config, let id = sessionId, let queue = uploadQueue else { return }
        let seq = nextSeq[source, default: 0]
        nextSeq[source] = seq + 1
        queue.enqueue(StenographerChunk(sessionId: id, uploadUrl: currentConfig.uploadUrl, token: currentConfig.uploadToken, source: source, seq: seq, capturedAtMs: capturedAtMs, data: data))
    }

    private func parseStartConfig(_ body: [String: Any]) -> StenographerStartConfig? {
        guard let sessionId = body["sessionId"] as? String, !sessionId.isEmpty,
              sessionId.range(of: #"^[A-Za-z0-9_-]{1,96}$"#, options: .regularExpression) != nil,
              let source = body["source"] as? String, ["microphone", "system", "both"].contains(source),
              let uploadUrlString = body["uploadUrl"] as? String,
              let uploadUrl = URL(string: uploadUrlString), isAllowedUploadURL(uploadUrl, sessionId: sessionId),
              let uploadToken = body["uploadToken"] as? String, (16...512).contains(uploadToken.count),
              let sampleRateNumber = body["sampleRate"] as? NSNumber,
              sampleRateNumber.intValue == Int(STENOGRAPHER_SAMPLE_RATE) else { return nil }
        return StenographerStartConfig(sessionId: sessionId, source: source, uploadUrl: uploadUrl, uploadToken: uploadToken, sampleRate: sampleRateNumber.intValue)
    }

    private func isAllowedUploadURL(_ url: URL, sessionId: String) -> Bool {
        guard url.scheme == "http", url.host == "127.0.0.1", url.port == PORT,
              url.user == nil, url.password == nil else { return false }
        let expected = "/api/stenographer/sessions/\(sessionId)/audio"
        return url.path == expected
    }

    private func parseDictionary(_ body: Any) -> [String: Any]? {
        if let dictionary = body as? [String: Any] { return dictionary }
        if let string = body as? String, let data = string.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data), let dictionary = object as? [String: Any] { return dictionary }
        if let data = body as? Data, let object = try? JSONSerialization.jsonObject(with: data), let dictionary = object as? [String: Any] { return dictionary }
        return nil
    }

    private func emitState(action: String, status: String, state: String, sessionId id: String? = nil) {
        emit([
            "schema": "stenographer_native_event.v1",
            "kind": "state",
            "action": action,
            "status": status,
            "state": state,
            "sessionId": (id ?? sessionId).map { $0 as Any } ?? NSNull(),
            "capturedAtMs": stenographerNowMs(),
            "sources": Array(requestedSources).sorted()
        ])
    }

    private func emitError(action: String, sessionId id: String?, source: String? = nil, code: String, message: String) {
        var payload: [String: Any] = [
            "schema": "stenographer_native_event.v1",
            "kind": "error",
            "action": action,
            "status": "error",
            "state": "error",
            "errorCode": code,
            "message": message,
            "error": ["code": code, "message": message],
            "sessionId": id ?? NSNull(),
            "capturedAtMs": stenographerNowMs(),
            "recoverable": code != "microphone_permission_denied" && code != "system_audio_permission_denied"
        ]
        if let source = source { payload["source"] = source }
        emit(payload)
    }

    private func emit(_ payload: [String: Any]) {
        eventHandler(payload)
    }
}

// WKWebView 会吃掉无边框标题栏的鼠标事件。用一条完全透明的原生视图
// 接管顶部空白区域的按下事件，恢复系统窗口拖动，同时避开左侧红绿灯和右侧工具按钮。
final class WindowDragRegionView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var loadInFlight = false
    var isTerminating = false
    var statusItem: NSStatusItem!
    var hostHealthTimer: Timer?
    var hostWakeObserver: NSObjectProtocol?
    var hostHealthProbeInFlight = false
    var hostEnsureInFlight = false
    var backgroundRecoveryLaunch = false
    var stenographerController: StenographerController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        backgroundRecoveryLaunch = consumeBackgroundLaunchSentinel()
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        installStatusItem()

        let rect = NSRect(x: 0, y: 0, width: 1280, height: 840)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        // 一体化无外框: 透明标题栏、隐藏标题、无分隔线(只留红绿灯)
        window.title = ""
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.minSize = NSSize(width: 960, height: 600)
        window.center()

        let config = WKWebViewConfiguration()
        // 只在原生客户端标记 macOS 窗口安全区；普通浏览器不改动布局。
        let desktopMarker = WKUserScript(
            source: "document.documentElement.dataset.shrimpDesktop = 'true'; document.documentElement.dataset.dashenNativeAdmin = 'true'; window.__dshNativeAdminAvailable = true",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(desktopMarker)
        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // 原生↔Web 语音桥: Web 端按钮 → 原生 SFSpeechRecognizer
        webView.configuration.userContentController.add(self, name: "shrimpVoice")
        // 原生↔Web 速记员桥: start/pause/resume/stop JSON
        webView.configuration.userContentController.add(self, name: "stenographer")
        // 钉钉订阅管理桥：只有大神.app拥有；普通浏览器没有这个message handler。
        // Native读取私有token并代发本机请求，token绝不进入JavaScript。
        webView.configuration.userContentController.add(self, name: "dingtalkSubscriptionAdmin")
        stenographerController = StenographerController { [weak self] payload in
            self?.notifyStenographerEvent(payload)
        }
        let contentContainer = NSView(frame: rect)
        contentContainer.autoresizingMask = [.width, .height]
        webView.frame = contentContainer.bounds
        webView.autoresizingMask = [.width, .height]
        contentContainer.addSubview(webView)
        window.contentView = contentContainer

        let dragHeight: CGFloat = 32
        let dragLeft: CGFloat = 96
        let dragRight: CGFloat = 300
        let dragRegion = WindowDragRegionView(frame: NSRect(
            x: dragLeft,
            y: max(0, contentContainer.bounds.height - dragHeight),
            width: max(120, contentContainer.bounds.width - dragLeft - dragRight),
            height: dragHeight
        ))
        dragRegion.autoresizingMask = [.width, .minYMargin]
        dragRegion.setAccessibilityElement(false)
        contentContainer.addSubview(dragRegion, positioned: .above, relativeTo: webView)

        // LaunchAgent recovery opens 大神 with -gj so TCC attaches to this App
        // without stealing focus. A normal user double-click still presents it.
        if !backgroundRecoveryLaunch {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }

        // 先等待 ensure-web 完成可能发生的 Host 重载，再连续确认两次 HTTP
        // 可用后加载页面，避免 WebView 命中旧插件 rev。
        startHostRecovery()
        installHostHealthMonitoring()
    }

    // 红色关闭按钮只隐藏窗口，保留 App、WebView 和 3080 Host。
    // Dock 点击图标可恢复原窗口；只有显式“退出大神”才终止 App 和服务。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if isTerminating { return true }
        sender.orderOut(nil)
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            backgroundRecoveryLaunch = false
            window.makeKeyAndOrderFront(nil)
            sender.activate(ignoringOtherApps: true)
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        isTerminating = true
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopHostHealthMonitoring()
        stenographerController?.interruptForTermination()
        if audioEngine.isRunning || recognitionRequest != nil || recognitionTask != nil {
            cleanupRecording()
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [STOP_SCRIPT]
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            // App 仍应退出；下次启动会通过 ensure-web 校正 Host 状态。
        }
    }

    // Watchdog writes this only for a hidden recovery launch. Always consume
    // the marker so a stale launch request cannot suppress a later user open.
    func consumeBackgroundLaunchSentinel() -> Bool {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: BACKGROUND_LAUNCH_SENTINEL) else { return false }
        defer { try? fileManager.removeItem(atPath: BACKGROUND_LAUNCH_SENTINEL) }
        guard let attributes = try? fileManager.attributesOfItem(atPath: BACKGROUND_LAUNCH_SENTINEL),
              let modified = attributes[.modificationDate] as? Date else { return false }
        let age = Date().timeIntervalSince(modified)
        return age >= -60 && age <= BACKGROUND_LAUNCH_MAX_AGE
    }

    func installHostHealthMonitoring() {
        hostHealthTimer?.invalidate()
        hostHealthTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.checkHostHealth()
        }
        hostHealthTimer?.tolerance = 3
        hostWakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self?.checkHostHealth()
            }
        }
    }

    func stopHostHealthMonitoring() {
        hostHealthTimer?.invalidate()
        hostHealthTimer = nil
        if let observer = hostWakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            hostWakeObserver = nil
        }
    }

    // 标准编辑菜单: 程序化 app 没有 mainMenu 时 Cmd+C/V/X/A 等编辑快捷键
    // 不会分发到 first responder(WKWebView 的 textarea),导致无法粘贴/复制。
    func installMainMenu() {
        let mainMenu = NSMenu()

        // App 菜单
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "退出大神", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // 编辑菜单 — 让 WKWebView 的 textarea 支持复制/粘贴/剪切/全选/撤销
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        NSApp.mainMenu = mainMenu
    }

    // ---- macOS 顶部菜单栏小 logo(虾缸 mark,有边框无文字) ----
    // 图标: Resources/menubar-logo.png(36px @2x, 展示 18pt)
    func installStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        guard let button = statusItem.button else { return }
        let iconPath = Bundle.main.path(forResource: "menubar-logo", ofType: "png") ?? ""
        if let img = NSImage(contentsOfFile: iconPath) {
            img.size = NSSize(width: 18, height: 18)
            button.image = img
        }
        button.toolTip = "大神"
        let menu = NSMenu()
        let showItem = NSMenuItem(title: "显示大神窗口", action: #selector(showMainWindow), keyEquivalent: "")
        showItem.target = self
        menu.addItem(showItem)
        // 托盘「刷新」: 仅重载 WKWebView 的 Web UI(浏览器级 ⌘R), 不触碰 host 进程。
        let refreshItem = NSMenuItem(title: "刷新", action: #selector(reloadWebView), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)
        menu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "退出大神", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.target = NSApp
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    @objc func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    // 托盘「刷新」(⌘R): 等同浏览器刷新, 只重载 WebView 页面, 不重启 host。
    @objc func reloadWebView() {
        webView?.reload()
    }

    // ---- 语音输入: macOS 系统语音识别(SFSpeechRecognizer),离线、中文 --
    var audioEngine = AVAudioEngine()
    var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    var recognitionTask: SFSpeechRecognitionTask?

    // Web 端按钮 → 原生: window.webkit.messageHandlers.shrimpVoice.postMessage('toggle')
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "shrimpVoice":
            micPressed()
        case "stenographer":
            stenographerController?.handleMessage(message.body)
        case "dingtalkSubscriptionAdmin":
            handleDingTalkSubscriptionAdmin(message)
        default:
            return
        }
    }

    private let dingtalkSubscriptionAdminActions: Set<String> = [
        "subscriber.list", "subscriber.create", "subscriber.update", "subscriber.suspend", "subscriber.resume", "subscriber.revoke",
        "robot.register", "robot.list", "robot.brand",
        "workspace.create", "workspace.host-create", "workspace.list", "workspace.share", "workspace.grant", "workspace.revoke",
        "entitlement.grant", "entitlement.revoke", "entitlement.list",
        "selection.set", "selection.list",
        "binding.begin", "binding.complete", "binding.consume",
        "quota.status", "quota.reset",
        "registration.begin", "registration.status", "registration.cancel",
        "catalog.list",
        "holiday.get", "holiday.upsert", "audit.list", "outbox.list"
    ]

    /// Receive one native-only subscription administration action.  The Web
    /// payload is deliberately small and untrusted; the Host remains the owner
    /// of schema validation, authorization, state and audit receipts.
    func handleDingTalkSubscriptionAdmin(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let currentURL = webView?.url,
              isInternalURL(currentURL),
              let body = parseNativeAdminDictionary(message.body),
              let requestId = body["requestId"] as? String,
              requestId.range(of: #"^[A-Za-z0-9._:-]{1,128}$"#, options: .regularExpression) != nil,
              let action = body["action"] as? String,
              dingtalkSubscriptionAdminActions.contains(action) else {
            notifyDingTalkSubscriptionAdmin([
                "requestId": (parseNativeAdminDictionary(message.body)?["requestId"] as? String) ?? "",
                "ok": false,
                "error": "invalid_native_admin_request"
            ])
            return
        }
        let payload = body["payload"] as? [String: Any] ?? [:]
        guard JSONSerialization.isValidJSONObject(payload),
              let token = try? String(contentsOfFile: DINGTALK_SUBSCRIPTION_ADMIN_TOKEN, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              (32...512).contains(token.count),
              let endpoint = URL(string: UI_URL + DINGTALK_SUBSCRIPTION_ADMIN_PATH) else {
            notifyDingTalkSubscriptionAdmin([
                "requestId": requestId,
                "ok": false,
                "error": "native_admin_capability_unavailable"
            ])
            return
        }
        let envelope: [String: Any] = [
            "requestId": requestId,
            "action": action,
            "payload": payload
        ]
        guard let requestBody = try? JSONSerialization.data(withJSONObject: envelope) else {
            notifyDingTalkSubscriptionAdmin([
                "requestId": requestId,
                "ok": false,
                "error": "invalid_native_admin_payload"
            ])
            return
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(token, forHTTPHeaderField: "X-Dashen-Native-Admin")
        request.httpBody = requestBody
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        URLSession(configuration: configuration).dataTask(with: request) { [weak self] data, response, error in
            var result: [String: Any] = ["requestId": requestId, "ok": false]
            if let error = error {
                result["error"] = "native_admin_transport_error"
                result["message"] = String(error.localizedDescription.prefix(400))
            } else if let http = response as? HTTPURLResponse {
                result["status"] = http.statusCode
                if let data = data, data.count <= DINGTALK_SUBSCRIPTION_ADMIN_MAX_RESPONSE_BYTES,
                   let decoded = try? JSONSerialization.jsonObject(with: data),
                   let dictionary = decoded as? [String: Any] {
                    let succeeded = (200..<300).contains(http.statusCode) && (dictionary["ok"] as? Bool ?? true)
                    result["ok"] = succeeded
                    if succeeded {
                        result["data"] = dictionary["data"] ?? dictionary
                    } else {
                        result["code"] = dictionary["code"] ?? "NATIVE_ADMIN_FAILED"
                        result["error"] = dictionary["error"] ?? "大神原生管理操作失败"
                    }
                } else {
                    result["error"] = data?.count ?? 0 > DINGTALK_SUBSCRIPTION_ADMIN_MAX_RESPONSE_BYTES
                        ? "native_admin_response_too_large"
                        : "native_admin_invalid_response"
                }
            } else {
                result["error"] = "native_admin_no_response"
            }
            self?.notifyDingTalkSubscriptionAdmin(result)
        }.resume()
    }

    private func parseNativeAdminDictionary(_ body: Any) -> [String: Any]? {
        if let dictionary = body as? [String: Any] { return dictionary }
        if let string = body as? String,
           let data = string.data(using: .utf8),
           data.count <= 262_144,
           let value = try? JSONSerialization.jsonObject(with: data),
           let dictionary = value as? [String: Any] { return dictionary }
        return nil
    }

    func notifyDingTalkSubscriptionAdmin(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.__dshDingTalkSubscriptionAdminResult && window.__dshDingTalkSubscriptionAdminResult(\(json))"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js) { _, _ in }
        }
    }

    // Native status callbacks are always delivered through the page's
    // __dshStenographerNativeEvent(payload) hook.  JSON serialization keeps
    // error strings and session IDs safe from JavaScript injection.
    func notifyStenographerEvent(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.__dshStenographerNativeEvent && window.__dshStenographerNativeEvent(\(json))"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js) { _, _ in }
        }
    }

    // 录音状态 → Web 按钮: window.__shrimpVoiceState(state)
    func notifyVoiceState(_ state: String) {
        webView?.evaluateJavaScript("window.__shrimpVoiceState && window.__shrimpVoiceState('\(state)')") { _, _ in }
    }

    @objc func micPressed() {
        if audioEngine.isRunning {
            stopRecording(final: true)
        } else {
            startRecording()
        }
    }

    func startRecording() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard status == .authorized else {
                    self.notifyVoiceState("denied")
                    return
                }
                do {
                    try self.beginRecording()
                    self.notifyVoiceState("recording")
                } catch {
                    self.notifyVoiceState("error")
                }
            }
        }
    }

    func beginRecording() throws {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
        guard let recognizer = recognizer, recognizer.isAvailable else {
            throw NSError(domain: "dashen", code: 1)
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let node = audioEngine.inputNode
        let format = node.outputFormat(forBus: 0)
        node.removeTap(onBus: 0)
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            self.recognitionRequest?.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result, result.isFinal {
                self.injectText(result.bestTranscription.formattedString)
                self.cleanupRecording()
            } else if error != nil {
                if let result = result {
                    self.injectText(result.bestTranscription.formattedString)
                }
                self.cleanupRecording()
            } else if result != nil {
                // 实时预览: 部分结果发到 Web 按钮 tooltip(可选,不打扰)
            }
        }
    }

    func stopRecording(final: Bool) {
        if final {
            recognitionRequest?.endAudio()
        } else {
            cleanupRecording()
        }
    }

    func cleanupRecording() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognitionRequest = nil
        recognitionTask = nil
        notifyVoiceState("idle")
    }

    // 把识别文本注入页面 textarea(受控组件: 原生 setter + input 事件)
    func injectText(_ text: String) {
        guard let webView = webView, !text.isEmpty else { return }
        // JSON 序列化文本,安全嵌入 JS
        let encoded: String
        if let data = try? JSONSerialization.data(withJSONObject: [text]) {
            let arr = String(data: data, encoding: .utf8) ?? "[]"
            encoded = String(arr.dropFirst().dropLast())
        } else {
            encoded = "\"\""
        }
        let js = """
        (() => {
          const ta = document.querySelector('textarea');
          if (!ta) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          const sep = (ta.value && !ta.value.endsWith('\\n')) ? ' ' : '';
          setter.call(ta, ta.value + sep + \(encoded));
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.focus();
          return true;
        })()
        """
        webView.evaluateJavaScript(js) { _, _ in }
    }

    // 后台确保服务运行。脚本可能先停掉旧 Host 再拉起新 Host，因此必须等
    // 脚本结束后再探测页面，不能看到旧 3080 就立即加载。
    func startHostRecovery() {
        guard !isTerminating, !hostEnsureInFlight else { return }
        hostEnsureInFlight = true
        ensureService { [weak self] in
            guard let self = self else { return }
            self.waitForStableService { [weak self] recovered in
                guard let self = self else { return }
                self.hostEnsureInFlight = false
                // A WebView reload is allowed only after two consecutive HTTP
                // probes prove that the Host recovered.  A failed ensure must
                // leave the current page untouched instead of reloading into a
                // white screen.
                guard recovered, !self.isTerminating else { return }
                self.loadWithRetry()
            }
        }
    }

    func checkHostHealth() {
        guard !isTerminating, !hostHealthProbeInFlight, !hostEnsureInFlight,
              let url = URL(string: UI_URL) else { return }
        hostHealthProbeInFlight = true
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let healthy = (response as? HTTPURLResponse).map { 200..<500 ~= $0.statusCode } ?? false
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.hostHealthProbeInFlight = false
                if !healthy { self.startHostRecovery() }
            }
        }.resume()
    }

    func ensureService(completion: @escaping () -> Void) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [ENSURE_SCRIPT]
        p.terminationHandler = { _ in
            DispatchQueue.main.async(execute: completion)
        }
        do {
            try p.run()
        } catch {
            DispatchQueue.main.async(execute: completion)
        }
    }

    func waitForStableService(attempt: Int = 0, stableChecks: Int = 0, completion: @escaping (Bool) -> Void) {
        guard attempt < 40, let url = URL(string: UI_URL) else {
            completion(false)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let ok = (response as? HTTPURLResponse).map { 200..<500 ~= $0.statusCode } ?? false
            let nextStable = ok ? stableChecks + 1 : 0
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                guard let self = self else { return }
                if nextStable >= 2 {
                    completion(true)
                } else {
                    self.waitForStableService(attempt: attempt + 1, stableChecks: nextStable, completion: completion)
                }
            }
        }.resume()
    }

    func loadWithRetry() {
        guard !loadInFlight else { return }
        loadInFlight = true
        if let url = URL(string: UI_URL) {
            webView.load(URLRequest(url: url))
        }
    }

    // 大神内部页保留在当前窗口；充值等外部链接交给系统默认浏览器。
    func isInternalURL(_ url: URL) -> Bool {
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == PORT
    }

    func openExternalURL(_ url: URL) {
        guard url.scheme == "https" || url.scheme == "http" else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if isInternalURL(url) || url.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        openExternalURL(url)
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            if isInternalURL(url) {
                webView.load(URLRequest(url: url))
            } else {
                openExternalURL(url)
            }
        }
        return nil
    }

    // 文件选择器: WKWebView 里的 <input type="file"> 不会自己弹面板,
    // 必须由宿主实现此回调, 否则 click() 被静默吞掉(dsh-paste-input 的
    // "Choose files / Choose folder" 就依赖它)。
    // completionHandler 必须调用, 否则 web 进程会一直等待。
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        // webkitdirectory("Choose folder") 需要允许选目录; WKOpenPanelParameters
        // 不暴露该标志, 因此文件和目录同时放开, 由用户在面板里自行选择。
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.prompt = "选择"
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // 服务未就绪(连接被拒) → 2 秒后重试
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadInFlight = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.startHostRecovery()
        }
    }

    // Successful navigation closes the in-flight gate.  Without this reset a
    // later Host recovery or content-process restart cannot load the page.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadInFlight = false
    }

    // WKWebView may lose its content process while the Host is still alive.
    // Re-enter the same guarded recovery path; it reloads once only after the
    // Host has passed the two-probe stability gate.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loadInFlight = false
        startHostRecovery()
    }

    // ---- WKWebView 默认不实现 window.alert/confirm/prompt：不实现这些代理时
    // 三者会被静默吞掉，confirm 恒返回 false（undefined），导致「运行虾」「抓虾
    // 发布/方案确认」等依赖 confirm 的按钮点了毫无反应。这里补上原生对话框。
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let textField = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        textField.stringValue = defaultText ?? ""
        alert.accessoryView = textField
        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn ? textField.stringValue : nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
