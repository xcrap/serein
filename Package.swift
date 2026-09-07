// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Serein",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Serein", targets: ["Serein"])],
    targets: [
        .executableTarget(name: "Serein", path: "native/Sources/Serein",
                          resources: [.copy("Resources")]),
        .testTarget(name: "SereinTests", dependencies: ["Serein"], path: "native/Tests")
    ]
)
