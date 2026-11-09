import PhotosUI
import SwiftUI
import UIKit

/// The insert sheet (MobileInsert.dc.html): one search field over pages to embed and blocks.
struct InsertSheet: View {
    let page: VaultNode
    let pages: [VaultNode]
    /// Runs after the sheet is gone, so the caret is back in the page when it lands.
    let onInsert: (Insertion) -> Void

    enum Insertion {
        case block(String)
        case embed(String)
        case image(String)
    }

    private struct BlockItem: Identifiable {
        let id: String
        let label: String
        let keys: String
        let symbol: String
    }

    private static let blocks: [BlockItem] = [
        BlockItem(id: "heading", label: "Heading", keys: "heading title h2", symbol: "textformat.size"),
        BlockItem(id: "checklist", label: "Checklist", keys: "checklist todo task check", symbol: "checklist"),
        BlockItem(id: "table", label: "Table", keys: "table grid rows columns", symbol: "tablecells"),
        BlockItem(id: "photo", label: "Photo", keys: "photo image picture camera", symbol: "photo"),
        BlockItem(id: "code", label: "Code", keys: "code pre snippet monospace", symbol: "curlybraces"),
        BlockItem(id: "ai", label: "Build with AI", keys: "ai build app generate", symbol: "sparkles"),
    ]

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var photo: PhotosPickerItem?
    @State private var photoError: String?
    @State private var candidates: [PageRanking.Candidate] = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    searchField
                    let ranked = PageRanking.rank(candidates, query: query, limit: query.isEmpty ? 5 : 20)
                    if !ranked.isEmpty { pagesSection(ranked) }
                    let shown = Self.blocks.filter(matches)
                    if !shown.isEmpty { blocksSection(shown) }
                    if ranked.isEmpty && shown.isEmpty {
                        Text("Nothing matches “\(query)”")
                            .font(.subheadline)
                            .foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 24)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .navigationTitle("Insert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .alert("Couldn't add the photo", isPresented: Binding(get: { photoError != nil }, set: { if !$0 { photoError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(photoError ?? "")
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { candidates = PageRanking.candidates(pages, excluding: page.path) }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task { await addPhoto(item) }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted).accessibilityHidden(true)
            TextField("Search blocks and pages", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 12)
        .frame(minHeight: 40)
        .background(Color(hex: 0xECEEF2), in: RoundedRectangle(cornerRadius: 10))
    }

    private func pagesSection(_ ranked: [PageRanking.Candidate]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("Embed a page")
            VStack(spacing: 0) {
                ForEach(Array(ranked.enumerated()), id: \.element.node.path) { i, c in
                    Button {
                        finish(.embed(c.node.path))
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: c.node.hasBackend || c.node.isBuilt ? "app" : "doc.text")
                                .foregroundStyle(i == 0 && !query.isEmpty ? Theme.accent : Theme.muted)
                                .frame(width: 22)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(c.title).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                                if !c.folder.isEmpty {
                                    Text(c.folder).font(.footnote).foregroundStyle(Theme.muted)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .multilineTextAlignment(.leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .frame(minHeight: 52)
                        .background(i == 0 && !query.isEmpty ? EditorTheme.accentSoft : .clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if i < ranked.count - 1 { Divider().padding(.leading, 14) }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        }
    }

    private func blocksSection(_ items: [BlockItem]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("Text")
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                ForEach(items) { item in
                    if item.id == "photo" {
                        PhotosPicker(selection: $photo, matching: .images) { tile(item) }
                            .buttonStyle(.plain)
                    } else if item.id == "ai" {
                        tile(item, note: "Coming soon").opacity(0.5)
                            .accessibilityElement(children: .combine)
                            .accessibilityAddTraits(.isButton)
                            .accessibilityRemoveTraits(.isSelected)
                            .disabled(true)
                    } else {
                        Button { finish(.block(item.id)) } label: { tile(item) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func tile(_ item: BlockItem, note: String? = nil) -> some View {
        VStack(spacing: 6) {
            Image(systemName: item.symbol).font(.body).accessibilityHidden(true)
            Text(item.label).font(.footnote.weight(.medium)).multilineTextAlignment(.center)
            if let note { Text(note).font(.caption2).foregroundStyle(Theme.muted) }
        }
        .foregroundStyle(Theme.ink)
        .padding(8)
        .frame(maxWidth: .infinity, minHeight: 72)
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .contentShape(Rectangle())
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private func matches(_ item: BlockItem) -> Bool {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        let hay = (item.label + " " + item.keys).lowercased()
        return words.allSatisfy { hay.contains($0) }
    }

    private func finish(_ insertion: Insertion) {
        dismiss()
        // After the sheet's dismissal, so the page has its first responder back.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { onInsert(insertion) }
    }

    private func addPhoto(_ item: PhotosPickerItem) async {
        defer { photo = nil }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { throw PageImages.Failure.unreadable }
            let src = try PageImages.save(data, into: page)
            finish(.image(src))
        } catch {
            photoError = error.localizedDescription
        }
    }
}

/// Photos added from the insert sheet: a JPEG in the page's own `images/` folder, linked
/// relative to the page (`images/photo-….jpg`), and marked for sync.
enum PageImages {
    enum Failure: LocalizedError {
        case unreadable
        var errorDescription: String? { "That photo couldn't be read." }
    }

    /// Longest side kept; phone photos are 4,000+ px and a page doesn't need that.
    static let maxSide: CGFloat = 2048

    static func save(_ data: Data, into page: VaultNode) throws -> String {
        guard let image = UIImage(data: data), let jpeg = downscaled(image).jpegData(compressionQuality: 0.82) else { throw Failure.unreadable }
        let fm = FileManager.default
        let folder = page.dir.appendingPathComponent("images", isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let stamp = Self.stamp.string(from: Date())
        var name = "photo-\(stamp).jpg"
        var n = 2
        while fm.fileExists(atPath: folder.appendingPathComponent(name).path) {
            name = "photo-\(stamp)-\(n).jpg"
            n += 1
        }
        try jpeg.write(to: folder.appendingPathComponent(name), options: .atomic)
        VaultChanges.shared.markChanged(path: "\(page.path)/images/\(name)")
        return "images/\(name)"
    }

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f
    }()

    private static func downscaled(_ image: UIImage) -> UIImage {
        let side = max(image.size.width, image.size.height)
        guard side > maxSide else { return image }
        let scale = maxSide / side
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }
}
