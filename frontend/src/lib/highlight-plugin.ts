import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';
import { registerGdscript } from '@/lib/gdscript-language';

// Ensure GDScript grammar is available (not shipped by highlight.js).
registerGdscript();

/**
 * Highlights code using highlight.js
 * Automatically detects language if not provided
 */
export function highlightCode(code: string, language: string = 'plaintext'): string {
  try {
    const lang = (language || 'plaintext').toLowerCase();
    const normalized = lang === 'gd' || lang === 'godot' ? 'gdscript' : lang;
    if (normalized && hljs.getLanguage(normalized)) {
      return hljs.highlight(code, { language: normalized }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch (err) {
    // Fallback to plaintext if highlighting fails
    return code;
  }
}
