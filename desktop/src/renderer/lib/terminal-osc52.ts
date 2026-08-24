export const MAX_OSC52_CLIPBOARD_CHARS = 100_000;

const MAX_OSC52_CLIPBOARD_BASE64_CHARS = Math.ceil(MAX_OSC52_CLIPBOARD_CHARS * 4 / 3) + 8;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeOsc52ClipboardText(data: string): string | null {
  const delimiterIndex = data.indexOf(';');
  if (delimiterIndex < 0) return null;

  const selector = data.slice(0, delimiterIndex);
  const encoded = data.slice(delimiterIndex + 1);
  if (encoded === '?' || encoded.length === 0) return null;
  if (selector !== '' && !selector.includes('c')) return null;
  if (encoded.length > MAX_OSC52_CLIPBOARD_BASE64_CHARS) return null;
  if (encoded.length % 4 === 1 || !BASE64_PATTERN.test(encoded)) return null;

  try {
    const binary = globalThis.atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    if (text.length > MAX_OSC52_CLIPBOARD_CHARS) return null;
    return text;
  } catch {
    return null;
  }
}
