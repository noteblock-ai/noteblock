import SwiftUI

@main
struct QuireApp: App {
    @StateObject private var vault: VaultModel

    init() {
        // Open (and on first launch, seed) the vault before the first frame, so -openPage
        // can push its page right away.
        let model = VaultModel()
        model.open()
        _vault = StateObject(wrappedValue: model)
        _ = SyncEngine.shared // starts auto-sync (on foreground + every 5 min) when set up
    }

    var body: some Scene {
        WindowGroup {
            ContentView(vault: vault)
                // Pages are light only (theme.css has no dark block); keep the chrome with them.
                .preferredColorScheme(.light)
        }
    }
}

/// Launch arguments (`simctl launch <udid> org.harborapps.quire.mobile -openPage "Welcome"`).
enum LaunchOptions {
    /// A page path or id to open at launch.
    static var openPage: String? {
        UserDefaults.standard.string(forKey: "openPage").flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Open Settings at launch (`-openSettings YES`, or the bare flag).
    static var openSettings: Bool {
        UserDefaults.standard.bool(forKey: "openSettings") || ProcessInfo.processInfo.arguments.last == "-openSettings"
    }

    /// Prefill the home screen's search (`-search "kyoto"`).
    static var search: String? {
        UserDefaults.standard.string(forKey: "search").flatMap { $0.isEmpty ? nil : $0 }
    }

    /// DEBUG: a JavaScript expression to evaluate in the opened page (see PageController).
    static var debugEval: String? {
        UserDefaults.standard.string(forKey: "debugEval").flatMap { $0.isEmpty ? nil : $0 }
    }
}
