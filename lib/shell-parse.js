/**
 * A small, conservative shell command reader.
 *
 * The guard never executes anything: it only needs to know which words are
 * path-like, which program each pipeline segment runs, and whether the text
 * contains indirection the reader cannot follow. Command substitution, inline
 * interpreters and nested shells mark the command uncertain, and the caller
 * turns uncertainty into a human confirmation. Well-formed heredoc bodies are
 * skipped because they are file content, not commands the shell will run.
 *
 * @module dsh-project-guard/lib/shell-parse
 */

/** Shell control operators that end one simple command. */
const SEGMENT_SEPARATORS = new Set([';', '\n', '|', '&']);

/** Words that assign an environment variable rather than run a program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Interpreter flags that carry inline code instead of a file path. */
const INLINE_CODE_FLAG = /^-{1,2}(c|e|eval)$/;

/** Programs whose `-c`/`-e` flag carries code the guard cannot inspect. */
const INLINE_CODE_PROGRAMS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun',
  'perl', 'ruby', 'php', 'lua', 'osascript', 'swift', 'julia'
]);

/** Programs whose argument *is* code, so it can never be inspected safely. */
const CODE_PROGRAMS = new Set(['eval', 'source', '.']);

/**
 * Read one command string.
 *
 * @param {string} command raw command text.
 * @returns {{
 *   segments: Array<{words: string[], command: string|undefined, raw: string}>,
 *   paths: string[],
 *   substitutions: boolean,
 *   unbalanced: boolean,
 *   uncertain: boolean,
 *   notes: string[]
 * }}
 */
export function parseShellCommand(command) {
  const text = typeof command === 'string' ? command : '';
  const segments = [];
  const paths = [];
  const notes = [];
  let words = [];
  let redirects = [];
  let word = '';
  let mode = 'normal';
  let pendingRedirect = false;
  let substitutions = false;
  let unbalanced = false;
  let uncertain = false;

  const flushWord = () => {
    if (word.length === 0) return;
    if (pendingRedirect) {
      pendingRedirect = false;
      if (!word.startsWith('&')) redirects.push(word);
    } else {
      words.push(word);
    }
    word = '';
  };

  const flushSegment = () => {
    flushWord();
    if (pendingRedirect) {
      pendingRedirect = false;
      uncertain = true;
      notes.push('a redirection has no target');
    }
    if (words.length > 0 || redirects.length > 0) {
      let program;
      for (const candidate of words) {
        if (ASSIGNMENT.test(candidate)) continue;
        program = candidate;
        break;
      }
      segments.push({ words: [...words], command: program, raw: words.join(' ') });
      paths.push(...redirects);
      paths.push(...words);
    }
    words = [];
    redirects = [];
  };

  /** Skip a heredoc body: everything up to the delimiter line after `from`. */
  const skipHeredocBody = (from, delimiter, stripTabs) => {
    if (delimiter.length === 0) return from;
    let cursor = text.indexOf('\n', from);
    if (cursor === -1) return text.length;
    cursor += 1;
    for (;;) {
      const end = text.indexOf('\n', cursor);
      const line = end === -1 ? text.slice(cursor) : text.slice(cursor, end);
      const candidate = stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === delimiter) return end === -1 ? text.length : end + 1;
      if (end === -1) return text.length;
      cursor = end + 1;
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (mode === 'single') {
      if (char === "'") mode = 'normal';
      else word += char;
      continue;
    }

    if (mode === 'double') {
      if (char === '\\') {
        word += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (char === '"') {
        mode = 'normal';
        continue;
      }
      if (char === '`' || (char === '$' && text[i + 1] === '(')) substitutions = true;
      word += char;
      continue;
    }

    if (char === '\\') {
      word += text[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (char === "'") {
      mode = 'single';
      continue;
    }
    if (char === '"') {
      mode = 'double';
      continue;
    }
    if (char === '`' || (char === '$' && text[i + 1] === '(')) {
      substitutions = true;
      word += char;
      continue;
    }
    if (char === '#' && word.length === 0) {
      while (i < text.length && text[i] !== '\n') i += 1;
      i -= 1;
      continue;
    }

    // File-descriptor duplication after a redirection: `2>&1`, `>&-`.
    if (pendingRedirect && char === '&') {
      let target = '&';
      i += 1;
      while (i < text.length && /[0-9-]/.test(text[i])) {
        target += text[i];
        i += 1;
      }
      pendingRedirect = false;
      i -= 1;
      continue;
    }

    if (char === '>' || char === '<') {
      if (/^[0-9]+$/.test(word)) word = ''; // leading fd number, not a word
      if (char === '<' && text[i + 1] === '<') {
        flushWord();
        i += 2;
        let stripTabs = false;
        if (text[i] === '-') {
          stripTabs = true;
          i += 1;
        }
        while (i < text.length && /\s/.test(text[i])) i += 1;
        let delimiter = '';
        while (i < text.length && !/[\s;|&<>]/.test(text[i])) {
          const inner = text[i];
          if (inner === "'" || inner === '"') {
            const quote = inner;
            i += 1;
            while (i < text.length && text[i] !== quote) {
              delimiter += text[i];
              i += 1;
            }
            i += 1;
            continue;
          }
          if (inner === '\\') {
            delimiter += text[i + 1] ?? '';
            i += 2;
            continue;
          }
          delimiter += inner;
          i += 1;
        }
        pendingRedirect = false;
        i = skipHeredocBody(i, delimiter, stripTabs) - 1;
        continue;
      }
      if (char === '>' && (text[i + 1] === '>' || text[i + 1] === '|')) i += 1;
      flushWord();
      pendingRedirect = true;
      continue;
    }

    if (SEGMENT_SEPARATORS.has(char)) {
      if ((char === '|' || char === '&') && text[i + 1] === char) i += 1;
      if (char === '&' && text[i + 1] === '>') {
        pendingRedirect = true;
        i += text[i + 2] === '>' ? 2 : 1;
        continue;
      }
      flushSegment();
      continue;
    }

    if (/\s/.test(char)) {
      flushWord();
      continue;
    }

    word += char;
  }

  if (mode !== 'normal') {
    unbalanced = true;
    notes.push(`unterminated ${mode} quote`);
  }
  flushSegment();

  if (substitutions) notes.push('command substitution present');
  if (unbalanced) notes.push('unbalanced quotes');

  for (const segment of segments) {
    const program = programOf(segment);
    if (program === undefined) continue;
    if (CODE_PROGRAMS.has(program)) {
      uncertain = true;
      notes.push(`${program} evaluates text the guard cannot inspect`);
      continue;
    }
    if (!INLINE_CODE_PROGRAMS.has(program)) continue;
    if (segment.words.some((candidate) => INLINE_CODE_FLAG.test(candidate))) {
      uncertain = true;
      notes.push(`inline code passed to ${program} cannot be inspected`);
    }
  }

  return { segments, paths, substitutions, unbalanced, uncertain, notes };
}

/** The program name of one segment, without any directory prefix. */
export function programOf(segment) {
  if (segment === undefined || segment.command === undefined) return undefined;
  const command = segment.command;
  return command.includes('/') ? command.slice(command.lastIndexOf('/') + 1) : command;
}

/** Positional arguments of one segment, with assignments and the program dropped. */
export function argumentsOf(segment) {
  if (segment === undefined) return [];
  const result = [];
  let skippedProgram = false;
  for (const candidate of segment.words) {
    if (!skippedProgram) {
      if (ASSIGNMENT.test(candidate)) continue;
      skippedProgram = true;
      continue;
    }
    result.push(candidate);
  }
  return result;
}
