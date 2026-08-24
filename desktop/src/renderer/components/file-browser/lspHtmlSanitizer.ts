import DOMPurify from 'dompurify';

const sanitizer = DOMPurify(window);

export function sanitizeLspHtml(html: string): string {
  return sanitizer.sanitize(html);
}
