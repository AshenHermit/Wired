import hljs from 'highlight.js';

// GDScript is not shipped with highlight.js, so auto-detection produced
// inconsistent colors. Register a dedicated grammar derived from Python's
// (GDScript is Python-like) but with Godot-specific keywords and annotations.
function gdscript(hljs: any) {
  const IDENT_RE = /[\p{XID_Start}_]\p{XID_Continue}*/u;

  const RESERVED_WORDS = [
    'and', 'as', 'assert', 'await', 'break', 'breakpoint', 'class', 'class_name',
    'const', 'continue', 'elif', 'else', 'enum', 'extends', 'for', 'func',
    'if', 'in', 'is', 'match', 'not', 'or', 'pass', 'preload', 'return',
    'self', 'signal', 'static', 'super', 'var', 'void', 'while', 'when',
    'yield', 'true', 'false', 'null',
  ];

  const BUILT_INS = [
    'print', 'push_error', 'push_warning', 'range', 'len', 'str', 'int',
    'float', 'bool', 'Vector2', 'Vector3', 'Color', 'Node', 'Node2D',
    'Node3D', 'Resource', 'PackedScene', 'Input', 'Engine', 'Time',
  ];

  const KEYWORDS = {
    $pattern: /[A-Za-z_]\w*/,
    keyword: RESERVED_WORDS,
    built_in: BUILT_INS,
    literal: ['true', 'false', 'null'],
  };

  const STRING = {
    className: 'string',
    contains: [hljs.BACKSLASH_ESCAPE],
    variants: [
      { begin: /"""[\s\S]*?"""/, relevance: 10 },
      { begin: /'''[\s\S]*?'''/, relevance: 10 },
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
    ],
  };

  const NUMBER = {
    className: 'number',
    relevance: 0,
    begin: /\b(\d+(\.\d+)?|\.\d+)\b/,
  };

  const COMMENT = hljs.HASH_COMMENT_MODE;

  const ANNOTATION = {
    className: 'meta',
    begin: /^[\t ]*@[\w.]+/,
  };

  const FUNC_DEF = {
    begin: [/\bfunc\b/, /\s+/, IDENT_RE],
    className: { 1: 'keyword', 3: 'title.function' },
    contains: [{ begin: /\(/, end: /\)/, contains: [hljs.APOS_STRING_MODE, hljs.QUOTE_STRING_MODE] }],
  };

  const CLASS_DEF = {
    begin: [/\bclass_name\b/, /\s+/, IDENT_RE],
    className: { 1: 'keyword', 3: 'title.class' },
  };

  return {
    name: 'GDScript',
    aliases: ['gdscript', 'godot'],
    case_insensitive: false,
    keywords: KEYWORDS,
    contains: [
      ANNOTATION,
      COMMENT,
      STRING,
      NUMBER,
      FUNC_DEF,
      CLASS_DEF,
      { match: /\bself\b/, scope: 'variable.language' },
    ],
  };
}

export function registerGdscript() {
  if (!hljs.getLanguage('gdscript')) {
    hljs.registerLanguage('gdscript', gdscript);
    hljs.registerLanguage('godot', gdscript);
  }
}

export default gdscript;
