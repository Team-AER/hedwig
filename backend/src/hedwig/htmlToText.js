import { extractHtmlContent } from '../services/emailContent.js';

export function convert(html) {
  return extractHtmlContent(html).text;
}
