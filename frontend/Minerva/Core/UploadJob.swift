//
//  UploadJob.swift
//  Minerva
//

import Foundation
import Observation

/// One file going through register → upload to S3 → processing → ready.
@Observable
final class UploadJob: Identifiable {
    enum State: Equatable {
        case uploading
        case processing(FileStatus)
        case ready
        case failed(String)
    }

    let id = UUID()
    let courseId: String
    let assignmentId: String?
    let file: PickedFile
    let docType: DocType
    var title: String?

    var state: State = .uploading
    var fileId: String?

    init(courseId: String, assignmentId: String? = nil, file: PickedFile, docType: DocType, title: String? = nil) {
        self.courseId = courseId
        self.assignmentId = assignmentId
        self.file = file
        self.docType = docType
        self.title = title
    }

    var statusText: String {
        switch state {
        case .uploading: "Uploading"
        case .processing: "Processing"
        case .ready: "Ready"
        case .failed: "Upload failed"
        }
    }

    var isFailed: Bool { if case .failed = state { true } else { false } }
    var isReady: Bool { state == .ready }
    var isFinished: Bool { isFailed || isReady }
}
