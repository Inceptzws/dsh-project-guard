import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseYaml } from '../lib/yaml.js'

// The published rule schema this parser has to handle verbatim.
const RULE_YAML = `id: R-FILE-DEL-01
action: {type: delete, target_kind: file}
state_predicates:
  - vcs.uncommitted(target) == true
  - backup.exists(target, max_age: 7d) == false
interest: {dimension: data_work, item: "uncommitted work in \${target}"}
consequence:
  type: irreversible_data_loss
  severity: high
  recoverability: low
  confidence: 0.9
disclosure:
  life: "This file holds changes you haven't saved elsewhere. If it is deleted, that work may be lost."
  technical: "target has uncommitted modifications; no backup newer than 7d detected"
`

test('parses the published rule schema exactly', () => {
  assert.deepEqual(parseYaml(RULE_YAML), {
    id: 'R-FILE-DEL-01',
    action: { type: 'delete', target_kind: 'file' },
    state_predicates: [
      'vcs.uncommitted(target) == true',
      'backup.exists(target, max_age: 7d) == false',
    ],
    interest: {
      dimension: 'data_work',
      item: 'uncommitted work in ${target}',
    },
    consequence: {
      type: 'irreversible_data_loss',
      severity: 'high',
      recoverability: 'low',
      confidence: 0.9,
    },
    disclosure: {
      life:
        "This file holds changes you haven't saved elsewhere. If it is deleted, that work may be lost.",
      technical:
        'target has uncommitted modifications; no backup newer than 7d detected',
    },
  })
})

test('parses nested block mappings', () => {
  const value = parseYaml(`server:
  host: localhost
  port: 8080
  options:
    retries: 3
    enabled: true
`)
  assert.deepEqual(value, {
    server: {
      host: 'localhost',
      port: 8080,
      options: { retries: 3, enabled: true },
    },
  })
})

test('parses a sequence of mappings aligned on the first key', () => {
  const value = parseYaml(`- id: R-1
  action: {type: delete}
  targets:
    - a.txt
    - b.txt
`)
  assert.deepEqual(value, [
    {
      id: 'R-1',
      action: { type: 'delete' },
      targets: ['a.txt', 'b.txt'],
    },
  ])
})

test('parses a sequence of scalars', () => {
  const value = parseYaml(`items:
  - alpha
  - "beta"
  - 3
`)
  assert.deepEqual(value, { items: ['alpha', 'beta', 3] })
})

test('parses quoted strings, escapes and # inside quotes', () => {
  const value = parseYaml(`double: "line1\\nline2\\ttab \\"q\\" back\\\\slash"
single: 'it''s ok'
hash: "no # comment here"
plain: value # comment
frag: http://example.com/#frag
apostrophe: it's fine # trailing comment
`)
  assert.deepEqual(value, {
    double: 'line1\nline2\ttab "q" back\\slash',
    single: "it's ok",
    hash: 'no # comment here',
    plain: 'value',
    frag: 'http://example.com/#frag',
    apostrophe: "it's fine",
  })
})

test('resolves integers, floats, booleans, yes/no and nulls', () => {
  const value = parseYaml(`int: 42
neg: -7
float: 3.14
exp: 1e3
yes_v: yes
no_v: no
true_v: true
false_v: false
null_a: null
null_b: ~
null_c:
code: 7d
`)
  assert.deepEqual(value, {
    int: 42,
    neg: -7,
    float: 3.14,
    exp: 1000,
    yes_v: true,
    no_v: false,
    true_v: true,
    false_v: false,
    null_a: null,
    null_b: null,
    null_c: null,
    code: '7d',
  })
})

test('parses a literal block scalar', () => {
  const value = parseYaml(`text: |
  line one
  line two
next: 1
`)
  assert.deepEqual(value, { text: 'line one\nline two\n', next: 1 })
})

test('parses a folded block scalar', () => {
  const value = parseYaml(`text: >
  line one
  line two

  line three
`)
  assert.equal(value.text, 'line one line two\nline three\n')
})

test('honours - and + chomping', () => {
  const stripped = parseYaml(`text: |-
  a
  b
`)
  assert.equal(stripped.text, 'a\nb')

  const kept = parseYaml(`text: |+
  a

next: 1
`)
  assert.deepEqual(kept, { text: 'a\n\n', next: 1 })
})

test('honours an explicit block scalar indentation indicator', () => {
  const value = parseYaml(`text: |2
    indented
`)
  assert.equal(value.text, '  indented\n')
})

test('parses nested flow sequences and flow mappings', () => {
  const value = parseYaml(`seq: [1, two, "three, four", [5, 6], {a: 1}]
map: {a: 1, b: [true, null], "c d": 'e f'}
`)
  assert.deepEqual(value, {
    seq: [1, 'two', 'three, four', [5, 6], { a: 1 }],
    map: { a: 1, b: [true, null], 'c d': 'e f' },
  })
})

test('parses a flow collection continued across lines', () => {
  const value = parseYaml(`flow: [
  1,
  2,
]
`)
  assert.deepEqual(value, { flow: [1, 2] })
})

test('ignores --- and ... document markers', () => {
  const value = parseYaml(`---
key: value  # inline comment
...
`)
  assert.deepEqual(value, { key: 'value' })
})

test('returns null for an empty document', () => {
  assert.equal(parseYaml(''), null)
  assert.equal(parseYaml('\n\n'), null)
  assert.equal(parseYaml('# just a comment\n'), null)
  assert.equal(parseYaml('---\n...\n'), null)
})

test('throws with a line number for tab indentation', () => {
  assert.throws(
    () => parseYaml('key:\n\tvalue\n'),
    (error) => error instanceof Error && /tab/i.test(error.message) && /line 2/.test(error.message)
  )
})

test('keeps the last duplicate key', () => {
  const value = parseYaml(`a: 1
b: 2
a: 3
`)
  assert.deepEqual(value, { a: 3, b: 2 })
})

test('keeps colon-bearing predicates as plain strings inside sequences', () => {
  const value = parseYaml(`predicates:
  - vcs.uncommitted(target) == true
  - backup.exists(target, max_age: 7d) == false
`)
  assert.deepEqual(value, {
    predicates: [
      'vcs.uncommitted(target) == true',
      'backup.exists(target, max_age: 7d) == false',
    ],
  })
})

test('throws with a line number for unterminated quotes and stray content', () => {
  assert.throws(() => parseYaml('a: "oops'), /line 1/)
  assert.throws(() => parseYaml("a: 'oops"), /line 1/)
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), /line 2/)
})
