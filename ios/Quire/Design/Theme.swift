import SwiftUI
import UIKit

/// Ledger, the desktop's look (app/runtime/theme.css), as native colors.
///
/// theme.css has no dark variant, so pages are always light; the app pins itself to light
/// (QuireApp) so the native chrome matches the page under it. When theme.css grows a dark
/// block, give these dark values and drop the pin.
///
/// Fonts: Geist ships as .woff2 in app/runtime/fonts, which UIFont can't load, so native
/// chrome uses the system font (SF, close to Geist) with semantic text styles. Pages in the
/// web view still get Geist from theme.css.
enum Theme {
    static let background = Color(hex: 0xFFFFFF)
    static let sidebar = Color(hex: 0xF8F9FB)
    static let line = Color(hex: 0xE4E6EA)
    static let ink = Color(hex: 0x15171C)
    static let muted = Color(hex: 0x5B6270)
    static let accent = Color(hex: 0x3451D1)

    static let uiBackground = UIColor(hex: 0xFFFFFF)
    static let uiInk = UIColor(hex: 0x15171C)
    static let uiAccent = UIColor(hex: 0x3451D1)
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension Color {
    init(hex: UInt32) { self.init(uiColor: UIColor(hex: hex)) }
}
