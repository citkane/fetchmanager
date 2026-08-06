export function decode_html(str: string) {
  return str.replace(/&#(x?[0-9a-fA-F]+);/g, (_, hexOrDec) => {
    const codePoint = hexOrDec.toLowerCase().startsWith("x")
      ? parseInt(hexOrDec.slice(1), 16)
      : parseInt(hexOrDec, 10);
    if (!Number.isFinite(codePoint)) return _;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return _;
    }
  });
}
