import Foundation

/// The product's public name: the bundle's display name, which project.yml sets from
/// core/brand.mjs's BRAND.name (scripts/build-mobile-host.mjs checks they match). Internal
/// identifiers (bundle id, the quire:// scheme, type names) stay "quire" on purpose.
enum Brand {
    static let name: String = {
        let info = Bundle.main.infoDictionary
        return (info?["CFBundleDisplayName"] as? String) ?? (info?["CFBundleName"] as? String) ?? "Noteblock"
    }()
}
