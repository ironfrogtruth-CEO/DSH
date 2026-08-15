import Foundation
import Vision
import ImageIO

if CommandLine.arguments.count < 2 {
    fputs("usage: vision_ocr <image-path>\n", stderr)
    exit(2)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fputs("failed to load image: \(path)\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest { request, error in
    if let error = error {
        fputs("ocr error: \(error.localizedDescription)\n", stderr)
        exit(1)
    }

    let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let confidence = String(format: "%.3f", candidate.confidence)
        print("\(confidence)\t\(candidate.string)")
    }
}

request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.minimumTextHeight = 0.006

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("ocr error: \(error.localizedDescription)\n", stderr)
    exit(1)
}
