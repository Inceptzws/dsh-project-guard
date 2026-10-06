/**
 * yaml.js — a tiny, zero-dependency YAML *subset* parser.
 *
 * This is deliberately NOT a general YAML implementation. It covers the narrow
 * slice of YAML used by this plugin's rule files:
 *
 *   - `#` comments at the start of a line or after whitespace (never in quotes)
 *   - block mappings and block sequences driven by indentation (spaces only)
 *   - sequences of mappings (`- key: value`, following keys aligned with `key`)
 *   - nesting by deeper indentation
 *   - plain, single-quoted (`''`) and double-quoted (`\"`, `\\`, `\n`, `\t`) scalars
 *   - integers, floats, `true/false/yes/no`, `null`/`~`/empty value -> null
 *   - inline comments after a value
 *   - literal (`|`) and folded (`>`) block scalars, with `-`/`+` chomping and an
 *     optional indentation indicator
 *   - flow collections `[...]` and `{...}`, one or more levels deep, with quoted
 *     strings inside (may continue across lines while brackets stay open)
 *   - `---` and `...` document markers on their own line (ignored)
 *
 * Not supported on purpose: anchors/aliases, tags, merge keys, multiple
 * documents, complex/quoted-multi-word plain mapping keys, multi-line plain
 * scalars, and tabs for indentation. Unsupported input throws an `Error` whose
 * message ends with `(line N)`.
 */

/**
 * Parse a YAML subset.
 *
 * @param {string} text - YAML source text.
 * @returns {unknown} JSON-compatible value (objects, arrays, strings, numbers,
 *   booleans, null).
 * @throws {Error} with a line number when the input uses something unsupported.
 */
export function parseYaml(text) {
  if (typeof text !== 'string') {
    throw new Error('yaml: input must be a string (line 1)')
  }

  const lines = buildLines(text)
  let pos = 0

  /**
   * Reject tab-indented lines at the point where they are used structurally.
   * @param {Line} line
   */
  function checkLine(line) {
    if (line.tabIndent) {
      throw new Error(
        `yaml: tab character is not allowed for indentation (line ${line.lineNo})`
      )
    }
  }

  /**
   * Advance past blank/comment lines (and document markers at top level).
   * @param {boolean} skipMarkers
   */
  function skipIgnorable(skipMarkers) {
    while (pos < lines.length) {
      const line = lines[pos]
      if (line.isBlank || line.isComment || (skipMarkers && line.isMarker)) {
        pos++
      } else {
        break
      }
    }
  }

  /**
   * Index of the next significant line, or -1.
   * @returns {number}
   */
  function peekSignificant() {
    let idx = pos
    while (idx < lines.length && (lines[idx].isBlank || lines[idx].isComment)) {
      idx++
    }
    return idx < lines.length ? idx : -1
  }

  /**
   * Parse the node that starts at the current line.
   * @param {number} indent
   * @param {number} [blockParentIndent] - nesting bound used by block scalars.
   * @returns {unknown}
   */
  function parseNode(indent, blockParentIndent) {
    const parentIndent =
      blockParentIndent === undefined ? indent : blockParentIndent
    const line = lines[pos]
    checkLine(line)
    if (line.indent > indent) {
      throw new Error(`yaml: unexpected indentation (line ${line.lineNo})`)
    }
    const s = line.stripped.trimEnd()
    if (isSequenceEntry(s)) {
      return parseSequence(indent)
    }
    const kv = splitKeyValue(s, line.lineNo)
    if (kv) {
      return parseMapping(indent)
    }
    pos++
    const header = parseBlockScalarHeader(s)
    if (header) {
      return parseBlockScalar(parentIndent, header)
    }
    return parseInlineValue(s, line.lineNo)
  }

  /**
   * Parse a block sequence whose entries sit at `indent`.
   * @param {number} indent
   * @returns {unknown[]}
   */
  function parseSequence(indent) {
    const result = []
    while (true) {
      skipIgnorable(false)
      if (pos >= lines.length) break
      const line = lines[pos]
      if (line.isMarker) break
      checkLine(line)
      if (line.indent < indent) break
      if (line.indent > indent) {
        throw new Error(`yaml: unexpected indentation (line ${line.lineNo})`)
      }
      const s = line.stripped.trimEnd()
      if (!isSequenceEntry(s)) break
      const afterDash = s.slice(1)
      const pad = /^[ \t]*/.exec(afterDash)[0].length
      const rest = afterDash.slice(pad)
      if (rest === '') {
        pos++
        const idx = peekSignificant()
        if (idx >= 0 && lines[idx].indent > indent) {
          pos = idx
          result.push(parseNode(lines[idx].indent))
        } else {
          result.push(null)
        }
        continue
      }
      // Re-read the entry as a virtual line indented to where its value starts,
      // so `- id: R-1` and the following `  action: ...` share one indent.
      const itemIndent = line.indent + 1 + pad
      lines[pos] = { ...line, indent: itemIndent, stripped: rest }
      result.push(parseNode(itemIndent, line.indent))
    }
    return result
  }

  /**
   * Parse a block mapping whose keys sit at `indent`.
   * @param {number} indent
   * @returns {Record<string, unknown>}
   */
  function parseMapping(indent) {
    const result = {}
    while (true) {
      skipIgnorable(false)
      if (pos >= lines.length) break
      const line = lines[pos]
      if (line.isMarker) break
      checkLine(line)
      if (line.indent < indent) break
      if (line.indent > indent) {
        throw new Error(`yaml: unexpected indentation (line ${line.lineNo})`)
      }
      const s = line.stripped.trimEnd()
      if (isSequenceEntry(s)) {
        throw new Error(
          `yaml: unexpected sequence entry in a mapping (line ${line.lineNo})`
        )
      }
      const kv = splitKeyValue(s, line.lineNo)
      if (!kv) {
        throw new Error(
          `yaml: expected a "key: value" pair (line ${line.lineNo})`
        )
      }
      pos++
      result[kv.key] = parseValueAfterColon(kv.rest, indent, line.lineNo)
    }
    return result
  }

  /**
   * Parse everything that follows a `key:` separator.
   * @param {string} rest
   * @param {number} parentIndent
   * @param {number} lineNo
   * @returns {unknown}
   */
  function parseValueAfterColon(rest, parentIndent, lineNo) {
    const trimmed = rest.trim()
    if (trimmed === '') {
      const idx = peekSignificant()
      if (idx >= 0) {
        const line = lines[idx]
        checkLine(line)
        if (line.indent > parentIndent) {
          pos = idx
          return parseNode(line.indent)
        }
        if (
          line.indent === parentIndent &&
          isSequenceEntry(line.stripped.trimEnd())
        ) {
          pos = idx
          return parseSequence(parentIndent)
        }
      }
      return null
    }
    const header = parseBlockScalarHeader(trimmed)
    if (header) {
      return parseBlockScalar(parentIndent, header)
    }
    return parseInlineValue(trimmed, lineNo)
  }

  /**
   * Parse a scalar or flow collection given as inline text; flow collections
   * may consume following lines while brackets stay open.
   * @param {string} text
   * @param {number} lineNo
   * @returns {unknown}
   */
  function parseInlineValue(text, lineNo) {
    if (text[0] === '[' || text[0] === '{') {
      let flowText = text
      while (flowDepth(flowText) > 0) {
        skipIgnorable(false)
        if (pos >= lines.length) {
          throw new Error(
            `yaml: unterminated flow collection (line ${lineNo})`
          )
        }
        const line = lines[pos]
        checkLine(line)
        flowText += ' ' + line.stripped.trim()
        pos++
      }
      return parseFlow(flowText, lineNo)
    }
    if (text[0] === '"' || text[0] === "'") {
      const quoted = readQuotedString(text, 0, lineNo)
      const trailing = text.slice(quoted.end).trim()
      if (trailing !== '') {
        throw new Error(
          `yaml: unexpected content after a quoted scalar (line ${lineNo})`
        )
      }
      return quoted.value
    }
    return resolveScalar(text)
  }

  /**
   * Consume the indented body of a `|` / `>` block scalar.
   * @param {number} parentIndent
   * @param {{style: string, chomp: string, indent: number}} header
   * @returns {string}
   */
  function parseBlockScalar(parentIndent, header) {
    let contentIndent = header.indent > 0 ? parentIndent + header.indent : -1
    /** @type {string[]} */
    const collected = []
    while (pos < lines.length) {
      const line = lines[pos]
      if (line.raw.trim() === '') {
        collected.push('')
        pos++
        continue
      }
      if (contentIndent < 0) {
        if (line.indent <= parentIndent) break
        contentIndent = line.indent
      }
      if (line.indent < contentIndent) {
        if (header.indent > 0 && line.indent > parentIndent) {
          throw new Error(
            `yaml: block scalar is less indented than its indicator (line ${line.lineNo})`
          )
        }
        break
      }
      collected.push(line.raw.slice(contentIndent))
      pos++
    }
    return buildBlockScalar(header, collected)
  }

  skipIgnorable(true)
  if (pos >= lines.length) return null
  const first = lines[pos]
  checkLine(first)
  if (first.indent > 0) {
    throw new Error(`yaml: unexpected indentation (line ${first.lineNo})`)
  }
  const value = parseNode(first.indent, first.indent)
  skipIgnorable(true)
  if (pos < lines.length) {
    throw new Error(`yaml: unexpected content (line ${lines[pos].lineNo})`)
  }
  return value
}

/**
 * @typedef {object} Line
 * @property {string} raw - the line exactly as written (no newline).
 * @property {number} lineNo - 1-based source line number.
 * @property {number} indent - number of leading spaces.
 * @property {boolean} tabIndent - leading whitespace contains a tab.
 * @property {string} content - line without its indentation.
 * @property {string} stripped - content with a trailing `#` comment removed.
 * @property {boolean} isBlank - whitespace-only line.
 * @property {boolean} isComment - line whose first non-space char is `#`.
 * @property {boolean} isMarker - `---` or `...` on its own line.
 */

/**
 * Split source text into annotated lines.
 * @param {string} text
 * @returns {Line[]}
 */
function buildLines(text) {
  const src = text.replace(/\r\n?/g, '\n')
  const rawLines = src.split('\n')
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop()
  }
  return rawLines.map((raw, idx) => {
    let i = 0
    let spaces = 0
    let tabIndent = false
    while (i < raw.length) {
      if (raw[i] === ' ') {
        spaces++
        i++
      } else if (raw[i] === '\t') {
        tabIndent = true
        i++
      } else {
        break
      }
    }
    const content = raw.slice(i)
    const stripped = stripComment(content)
    return {
      raw,
      lineNo: idx + 1,
      indent: spaces,
      tabIndent,
      content,
      stripped,
      isBlank: content.trim() === '',
      isComment: content.trimStart().startsWith('#'),
      isMarker: /^(---|\.\.\.)$/.test(stripped.trim()),
    }
  })
}

/**
 * True when `- ` / `-` starts a block sequence entry.
 * @param {string} s
 * @returns {boolean}
 */
function isSequenceEntry(s) {
  return s === '-' || s.startsWith('- ') || s.startsWith('-\t')
}

/**
 * A quote only opens a scalar when it starts a token; this keeps apostrophes
 * inside plain words (for example `it's`) from being read as quotes.
 * @param {string} text
 * @param {number} i
 * @returns {boolean}
 */
function isQuoteStart(text, i) {
  if (i === 0) return true
  return /[\s[{(,:]/.test(text[i - 1])
}

/**
 * Remove a trailing `#` comment, honouring quoted sections.
 * @param {string} text
 * @returns {string}
 */
function stripComment(text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote === '"') {
      if (ch === '\\') {
        i++
      } else if (ch === '"') {
        quote = null
      }
      continue
    }
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") i++
        else quote = null
      }
      continue
    }
    if (ch === '#') {
      if (i === 0 || /\s/.test(text[i - 1])) return text.slice(0, i)
    } else if ((ch === '"' || ch === "'") && isQuoteStart(text, i)) {
      quote = ch
    }
  }
  return text
}

/**
 * Width of the still-open flow brackets, ignoring quoted text.
 * @param {string} text
 * @returns {number}
 */
function flowDepth(text) {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if ((ch === '"' || ch === "'") && isQuoteStart(text, i)) {
      const quote = ch
      i++
      while (i < text.length && text[i] !== quote) {
        if (quote === '"' && text[i] === '\\') i++
        i++
      }
    } else if (ch === '[' || ch === '{') {
      depth++
    } else if (ch === ']' || ch === '}') {
      depth--
    }
  }
  return depth
}

/**
 * Plain mapping keys must be bare tokens (no spaces, colons, brackets, ...).
 * This is what keeps `backup.exists(target, max_age: 7d) == false` a plain
 * scalar inside a sequence entry.
 * @param {string} key
 * @returns {boolean}
 */
function isBareKey(key) {
  return /^[^\s:#,()[\]{}'"]+$/.test(key)
}

/**
 * Split `key: value` text, handling quoted keys.
 * @param {string} text
 * @param {number} lineNo
 * @returns {{key: string, rest: string} | null}
 */
function splitKeyValue(text, lineNo) {
  if (text[0] === '"' || text[0] === "'") {
    const quoted = readQuotedString(text, 0, lineNo)
    let j = quoted.end
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++
    if (text[j] !== ':') return null
    if (j + 1 < text.length && text[j + 1] !== ' ' && text[j + 1] !== '\t') {
      return null
    }
    return { key: String(quoted.value), rest: text.slice(j + 1) }
  }
  for (let k = 1; k < text.length; k++) {
    if (
      text[k] === ':' &&
      (k + 1 === text.length || text[k + 1] === ' ' || text[k + 1] === '\t')
    ) {
      const key = text.slice(0, k).trim()
      return isBareKey(key) ? { key, rest: text.slice(k + 1) } : null
    }
  }
  return null
}

/**
 * Read a quoted scalar starting at `start`.
 * @param {string} text
 * @param {number} start
 * @param {number} lineNo
 * @returns {{value: string, end: number}} `end` is the index just past the closing quote.
 */
function readQuotedString(text, start, lineNo) {
  const quote = text[start]
  let i = start + 1
  let out = ''
  if (quote === "'") {
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          out += "'"
          i += 2
          continue
        }
        return { value: out, end: i + 1 }
      }
      out += text[i]
      i++
    }
    throw new Error(`yaml: unterminated single-quoted string (line ${lineNo})`)
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === '"') out += '"'
      else if (next === '\\') out += '\\'
      else if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === '/') out += '/'
      else {
        throw new Error(
          `yaml: unsupported escape sequence "\\${next ?? ''}" (line ${lineNo})`
        )
      }
      i += 2
    } else if (ch === '"') {
      return { value: out, end: i + 1 }
    } else {
      out += ch
      i++
    }
  }
  throw new Error(`yaml: unterminated double-quoted string (line ${lineNo})`)
}

/**
 * Resolve a plain scalar to null / boolean / number / string.
 * Anything that is not clearly typed stays a string (`7d` stays `"7d"`).
 * @param {string} raw
 * @returns {unknown}
 */
function resolveScalar(raw) {
  if (raw === '' || raw === '~') return null
  if (/^(null|Null|NULL)$/.test(raw)) return null
  if (/^(true|True|TRUE|yes|Yes|YES)$/.test(raw)) return true
  if (/^(false|False|FALSE|no|No|NO)$/.test(raw)) return false
  if (/^[+-]?\d+$/.test(raw)) return Number.parseInt(raw, 10)
  if (
    /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)$/.test(raw) ||
    /^[+-]?(\d+\.\d*|\.\d+)$/.test(raw)
  ) {
    return Number.parseFloat(raw)
  }
  return raw
}

/**
 * Recognise a `|` / `>` block scalar header.
 * @param {string} header
 * @returns {{style: string, chomp: string, indent: number} | null}
 */
function parseBlockScalarHeader(header) {
  const style = header[0]
  if (style !== '|' && style !== '>') return null
  const rest = header.slice(1)
  if (!/^[+-]?\d?[+-]?$/.test(rest)) return null
  let chomp = 'clip'
  let signs = 0
  let indent = -1
  for (const ch of rest) {
    if (ch === '-' || ch === '+') {
      signs++
      chomp = ch === '-' ? 'strip' : 'keep'
    } else {
      const digit = Number(ch)
      if (digit === 0) return null
      indent = digit
    }
  }
  if (signs > 1) return null
  return { style, chomp, indent }
}

/**
 * Apply folding and chomping to the collected block scalar lines.
 * @param {{style: string, chomp: string, indent: number}} header
 * @param {string[]} collected
 * @returns {string}
 */
function buildBlockScalar(header, collected) {
  let end = collected.length
  while (end > 0 && collected[end - 1] === '') end--
  const bodyLines = collected.slice(0, end)
  const trailingBlanks = collected.length - end
  if (bodyLines.length === 0) return ''

  let core
  if (header.style === '|') {
    core = bodyLines.join('\n')
  } else {
    core = ''
    let pendingBlanks = 0
    for (const line of bodyLines) {
      if (line === '') {
        pendingBlanks++
        continue
      }
      if (core === '') core = line
      else if (pendingBlanks > 0) core += '\n'.repeat(pendingBlanks) + line
      else core += ' ' + line
      pendingBlanks = 0
    }
  }
  if (core === '') return ''
  if (header.chomp === 'strip') return core
  if (header.chomp === 'keep') return core + '\n'.repeat(trailingBlanks + 1)
  return core + '\n'
}

/**
 * Parse a flow collection or scalar inside `[...]` / `{...}`.
 * @param {string} text
 * @param {number} lineNo
 * @returns {unknown}
 */
function parseFlow(text, lineNo) {
  let i = 0

  function ws() {
    while (i < text.length && /\s/.test(text[i])) i++
  }

  function parseValue() {
    ws()
    const ch = text[i]
    if (ch === '[') return parseSequence()
    if (ch === '{') return parseMapping()
    if (ch === '"' || ch === "'") {
      const quoted = readQuotedString(text, i, lineNo)
      i = quoted.end
      return quoted.value
    }
    const start = i
    while (i < text.length && text[i] !== ',' && text[i] !== ']' && text[i] !== '}') {
      i++
    }
    return resolveScalar(text.slice(start, i).trim())
  }

  function parseSequence() {
    i++ // consume '['
    const out = []
    ws()
    if (text[i] === ']') {
      i++
      return out
    }
    while (true) {
      out.push(parseValue())
      ws()
      if (text[i] === ',') {
        i++
        ws()
        if (text[i] === ']') {
          i++
          return out
        }
        continue
      }
      if (text[i] === ']') {
        i++
        return out
      }
      throw new Error(`yaml: malformed flow sequence (line ${lineNo})`)
    }
  }

  function parseMapping() {
    i++ // consume '{'
    const out = {}
    ws()
    if (text[i] === '}') {
      i++
      return out
    }
    while (true) {
      ws()
      let key
      if (text[i] === '"' || text[i] === "'") {
        const quoted = readQuotedString(text, i, lineNo)
        key = String(quoted.value)
        i = quoted.end
      } else {
        const start = i
        while (i < text.length && text[i] !== ':' && text[i] !== ',' && text[i] !== '}') {
          i++
        }
        key = text.slice(start, i).trim()
      }
      if (text[i] !== ':') {
        throw new Error(`yaml: malformed flow mapping (line ${lineNo})`)
      }
      i++
      out[key] = parseValue()
      ws()
      if (text[i] === ',') {
        i++
        ws()
        if (text[i] === '}') {
          i++
          return out
        }
        continue
      }
      if (text[i] === '}') {
        i++
        return out
      }
      throw new Error(`yaml: malformed flow mapping (line ${lineNo})`)
    }
  }

  const value = parseValue()
  ws()
  if (i < text.length) {
    throw new Error(
      `yaml: unexpected content in flow collection (line ${lineNo})`
    )
  }
  return value
}
