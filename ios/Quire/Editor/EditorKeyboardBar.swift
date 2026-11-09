import SwiftUI

/// Editor tints from the Mobile designs, beside Theme's tokens.
enum EditorTheme {
    /// The Edit capsule and the insert button: accent at low strength.
    static let accentSoft = Color(hex: 0xEEF1FD)
    /// A pressed formatting button (the caret is in a numbered list…).
    static let pressed = Color(hex: 0xE8EBF3)
}

/// The bar above the keyboard in edit mode (MobileEdit.dc.html): insert, text style, bold,
/// italic, numbered list, checklist, indent, and hide keyboard.
struct EditorKeyboardBar: View {
    static let height: CGFloat = 56

    @ObservedObject var session: EditorSession

    var body: some View {
        HStack(spacing: 2) {
            Button { session.showInsert = true } label: {
                Image(systemName: "plus")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .background(EditorTheme.accentSoft, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(Theme.accent)
            }
            .accessibilityLabel("Insert")

            Menu {
                styleButton("Title", level: 1, block: "h1")
                styleButton("Heading", level: 2, block: "h2")
                styleButton("Subheading", level: 3, block: "h3")
                styleButton("Body", level: 0, block: "p")
            } label: {
                Text("Aa")
                    .font(.subheadline.weight(.semibold))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Text style")

            barButton("Bold", pressed: session.state.bold, action: session.bold) {
                Text("B").font(.body.weight(.bold))
            }
            barButton("Italic", pressed: session.state.italic, action: session.italic) {
                Text("I").font(.body).italic()
            }
            barButton("Numbered list", pressed: session.state.block == "ol", action: { session.list("ol") }) {
                Image(systemName: "list.number")
            }
            barButton("Checklist", pressed: session.state.block == "checklist", action: session.checklist) {
                Image(systemName: "checklist")
            }
            barButton("Indent", pressed: false, action: session.indent) {
                Image(systemName: "increase.indent")
            }

            Spacer(minLength: 0)

            Button(action: session.hideKeyboard) {
                Image(systemName: "keyboard.chevron.compact.down")
                    .frame(width: 44, height: 44)
                    .foregroundStyle(Theme.muted)
            }
            .accessibilityLabel("Hide keyboard")
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.ink)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.sidebar)
        .overlay(alignment: .top) { Theme.line.frame(height: 1 / UIScreen.main.scale) }
    }

    private func styleButton(_ title: String, level: Int, block: String) -> some View {
        Button {
            session.heading(level)
        } label: {
            if session.state.block == block {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    private func barButton<L: View>(_ label: String, pressed: Bool, action: @escaping () -> Void, @ViewBuilder content: () -> L) -> some View {
        Button(action: action) {
            content()
                .frame(width: 40, height: 44)
                .background(pressed ? EditorTheme.pressed : .clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(pressed ? .isSelected : [])
    }
}
