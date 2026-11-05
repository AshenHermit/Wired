import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';

/**
 * Highlights code using highlight.js
 * Automatically detects language if not provided
 */
export function highlightCode(code: string, language: string = 'plaintext'): string {
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch (err) {
    // Fallback to plaintext if highlighting fails
    return code;
  }
}
