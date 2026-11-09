import ObjectiveC
import UIKit
import WebKit

/// Replaces WKWebView's keyboard accessory bar (the arrows/Done strip) with a view of ours.
///
/// The accessory belongs to WKContentView, WebKit's private first responder inside the web
/// view, not to WKWebView, so overriding WKWebView.inputAccessoryView does nothing. This gives
/// that one content view a runtime subclass whose `inputAccessoryView` asks `provider`; nil
/// means no bar at all (reading mode, where the keyboard only comes up for a page's own inputs).
enum KeyboardAccessory {
    private static var providerKey: UInt8 = 0
    private static let suffix = "_QuireAccessory"

    private final class Provider {
        let make: () -> UIView?
        init(_ make: @escaping () -> UIView?) { self.make = make }
    }

    /// Returns false when the content view isn't there yet (call again after the first layout).
    @discardableResult
    static func install(on webView: WKWebView, provider: @escaping () -> UIView?) -> Bool {
        guard let content = contentView(of: webView), let base = object_getClass(content) else { return false }
        objc_setAssociatedObject(content, &providerKey, Provider(provider), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        let baseName = NSStringFromClass(base)
        if baseName.hasSuffix(suffix) { return true }
        let name = baseName + suffix
        var sub: AnyClass? = NSClassFromString(name)
        if sub == nil, let made = objc_allocateClassPair(base, name, 0) {
            let block: @convention(block) (AnyObject) -> UIView? = { me in
                (objc_getAssociatedObject(me, &providerKey) as? Provider)?.make()
            }
            class_addMethod(made, #selector(getter: UIResponder.inputAccessoryView), imp_implementationWithBlock(block), "@@:")
            objc_registerClassPair(made)
            sub = made
        }
        guard let sub else { return false }
        object_setClass(content, sub)
        return true
    }

    /// Ask the keyboard to fetch the accessory again (after the provider's answer changed).
    static func reload(on webView: WKWebView) {
        contentView(of: webView)?.reloadInputViews()
    }

    private static func contentView(of webView: WKWebView) -> UIView? {
        webView.scrollView.subviews.first { NSStringFromClass(type(of: $0)).hasPrefix("WKContent") }
    }
}
