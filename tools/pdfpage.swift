// Render pages of a PDF to PNG (macOS PDFKit): pdfpage IN.pdf OUT_PREFIX [first] [last] [scale]
import PDFKit
import AppKit
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
let first = a.count > 3 ? Int(a[3])! : 1
let last = a.count > 4 ? Int(a[4])! : doc.pageCount
let scale = a.count > 5 ? CGFloat(Double(a[5])!) : 2.0
for i in first...min(last, doc.pageCount) {
    guard let page = doc.page(at: i - 1) else { continue }
    let r = page.bounds(for: .mediaBox)
    let size = NSSize(width: r.width * scale, height: r.height * scale)
    let img = NSImage(size: size)
    img.lockFocus()
    NSColor.white.set(); NSRect(origin: .zero, size: size).fill()
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    img.unlockFocus()
    let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(a[2])-\(i).png"))
    print("\(a[2])-\(i).png")
}
