import AppKit
import CoreText
import SwiftUI

/// The same Inter and JetBrains Mono fonts used by the original web app.
/// Font files and their OFL licenses are bundled with the app, never installed.
enum SereinType {
    static let ink = Color(red: 248 / 255, green: 246 / 255, blue: 242 / 255)
    static func register() {
        for name in ["Inter", "JetBrainsMono"] {
            let url = Bundle.main.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts")
                ?? Bundle.module.url(forResource: name, withExtension: "ttf", subdirectory: "Resources/Fonts")
            if let url { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
        }
    }
    static func ui(_ size: CGFloat, weight: CGFloat = 450) -> Font { variable("Inter-Regular", size, weight) }
    static func mono(_ size: CGFloat = 10.5) -> Font { variable("JetBrainsMono-Regular", size, 400) }
    private static func variable(_ name: String, _ size: CGFloat, _ weight: CGFloat) -> Font {
        let descriptor = CTFontDescriptorCreateWithAttributes([
            kCTFontNameAttribute: name,
            kCTFontVariationAttribute: [NSNumber(value: 0x77676874): weight]
        ] as CFDictionary)
        return Font(CTFontCreateWithFontDescriptor(descriptor, size, nil))
    }
}
