import test from 'node:test'
import assert from 'node:assert/strict'

import { highlightLines, HIGHLIGHT_LANGS, hasHighlighter } from '../plugins/code-viewer/src/highlight.ts'

/** Flatten tokens of one line back to a string; assert nothing was lost. */
function textOf(tokensByLine: Array<Array<{ text: string }>>, i: number): string {
  return (tokensByLine[i] ?? []).map(t => t.text).join('')
}

function fullText(tokensByLine: Array<Array<{ text: string }>>): string {
  return tokensByLine.map(l => l.map(t => t.text).join('')).join('\n')
}

function classesOf(tokensByLine: Array<Array<{ text: string; cls: string | null }>>, i: number): Array<[string, string | null]> {
  return (tokensByLine[i] ?? []).map(t => [t.text, t.cls])
}

// --- round-trip safety -------------------------------------------------------

test('tokens always reconstruct the original source exactly', () => {
  const samples: Array<[string, string]> = [
    ['const a = "hi"\n// note\nlet x = 0x1f + 2.5e3\n', 'javascript'],
    ['def f(x):\n\treturn "a\\"b" # c\n', 'python'],
    ['<div class="a">hi</div>\n<!-- c -->\n', 'html'],
    ['key: value\n"quoted": 1\n', 'yaml'],
    ['a = `one\ntwo\nthree`\nb', 'javascript'],
    ['/* multi\nline\ncomment */ x = 1', 'cpp'],
    ['unterminated = "oops\nnext line', 'javascript'],
    ['', 'javascript'],
    ['no trailing newline', 'rust'],
    ['#!shebang\nx=1', 'bash'],
  ]
  for (const [code, lang] of samples) {
    assert.equal(fullText(highlightLines(code, lang)), code, `round-trip failed for ${lang}: ${JSON.stringify(code)}`)
  }
})

// --- javascript --------------------------------------------------------------

test('javascript: keywords, strings, comments, numbers', () => {
  const lines = highlightLines('const x = "hi" // c\nlet n = 42', 'javascript')
  assert.deepEqual(classesOf(lines, 0).filter(([, c]) => c), [
    ['const', 'keyword'],
    ['"hi"', 'string'],
    ['// c', 'comment'],
  ])
  assert.deepEqual(classesOf(lines, 1).filter(([, c]) => c), [
    ['let', 'keyword'],
    ['42', 'number'],
  ])
})

test('javascript: template literal spans lines and closes', () => {
  const lines = highlightLines('const s = `a\nb`\nnext()', 'javascript')
  assert.equal(classesOf(lines, 0).at(-1)![1], 'string')
  assert.deepEqual(classesOf(lines, 1), [['b`', 'string']])
  // after the close, normal highlighting resumes
  assert.deepEqual(classesOf(lines, 2).filter(([, c]) => c), [])
})

test('javascript: unterminated string ends at newline', () => {
  const lines = highlightLines('let a = "oops\nlet b = 1', 'javascript')
  assert.equal(textOf(lines, 0), 'let a = "oops')
  assert.equal(classesOf(lines, 0).at(-1)![1], 'string')
  assert.deepEqual(classesOf(lines, 1).filter(([, c]) => c), [['let', 'keyword'], ['1', 'number']])
})

// --- python ------------------------------------------------------------------

test('python: def, atoms, hash comments, single-quoted strings', () => {
  const lines = highlightLines("def f():\n    return True  # yes", 'python')
  assert.deepEqual(classesOf(lines, 0).filter(([, c]) => c), [['def', 'keyword']])
  const cls = classesOf(lines, 1).filter(([, c]) => c)
  assert.ok(cls.some(([t, c]) => t === 'return' && c === 'keyword'))
  assert.ok(cls.some(([t, c]) => t === 'True' && c === 'atom'))
  assert.ok(cls.some(([t, c]) => t === '# yes' && c === 'comment'))
})

// --- markup ------------------------------------------------------------------

test('html: tags, attributes, strings, comments', () => {
  const lines = highlightLines('<a href="x">hi</a>', 'html')
  const cls = classesOf(lines, 0).filter(([, c]) => c)
  assert.ok(cls.some(([t, c]) => t === '<a' && c === 'tag'))
  assert.ok(cls.some(([t, c]) => t === 'href' && c === 'attribute'))
  assert.ok(cls.some(([t, c]) => t === '"x"' && c === 'string'))
  assert.ok(cls.some(([t, c]) => t === '>' && c === 'tag'))
  assert.ok(cls.some(([t, c]) => t === '</a' && c === 'tag'))
  assert.equal(textOf(lines, 0), '<a href="x">hi</a>')
})

// --- data languages ----------------------------------------------------------

test('json: keys are properties, values are strings/atoms/numbers', () => {
  const lines = highlightLines('{"a": 1, "b": true, "c": "v"}', 'json')
  const cls = classesOf(lines, 0).filter(([, c]) => c)
  assert.deepEqual(cls, [
    ['"a"', 'property'],
    ['1', 'number'],
    ['"b"', 'property'],
    ['true', 'atom'],
    ['"c"', 'property'],
    ['"v"', 'string'],
  ])
})

test('yaml: unquoted keys are properties', () => {
  const lines = highlightLines('name: demo\nenabled: true', 'yaml')
  assert.deepEqual(classesOf(lines, 0).filter(([, c]) => c), [['name', 'property']])
  assert.deepEqual(classesOf(lines, 1).filter(([, c]) => c), [['enabled', 'property'], ['true', 'atom']])
})

// --- c family ----------------------------------------------------------------

test('cpp: multi-line block comment keeps state across lines', () => {
  const lines = highlightLines('int a; /* start\nmiddle\nend */ int b;', 'cpp')
  assert.deepEqual(classesOf(lines, 0).filter(([, c]) => c), [['int', 'keyword'], ['/* start', 'comment']])
  assert.deepEqual(classesOf(lines, 1), [['middle', 'comment']])
  const cls = classesOf(lines, 2).filter(([, c]) => c)
  assert.ok(cls.some(([t, c]) => t === 'end */' && c === 'comment'))
  assert.ok(cls.some(([t, c]) => t === 'int' && c === 'keyword'))
})

// --- diff --------------------------------------------------------------------

test('diff: +/- lines, hunk headers, file headers', () => {
  const lines = highlightLines('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new', 'diff')
  assert.equal(classesOf(lines, 0)[0]![1], 'meta')
  assert.equal(classesOf(lines, 1)[0]![1], 'meta')
  assert.equal(classesOf(lines, 2)[0]![1], 'keyword')
  assert.equal(classesOf(lines, 3)[0]![1], 'tag')
  assert.equal(classesOf(lines, 4)[0]![1], 'string')
})

// --- fallback & registry -----------------------------------------------------

test('unknown language falls back to generic comments/strings/numbers', () => {
  const lines = highlightLines('x = 1 # note\ny = "s"', 'cobol')
  assert.deepEqual(classesOf(lines, 0).filter(([, c]) => c), [['1', 'number'], ['# note', 'comment']])
  assert.deepEqual(classesOf(lines, 1).filter(([, c]) => c), [['"s"', 'string']])
})

test('plain text emits no classes at all', () => {
  const lines = highlightLines('just some text\n123 456', 'text')
  assert.deepEqual(classesOf(lines, 0).filter(([, c]) => c), [])
  assert.deepEqual(classesOf(lines, 1).filter(([, c]) => c), [])
})

test('language picker lists common languages plus plain text', () => {
  const ids = HIGHLIGHT_LANGS.map(l => l.id)
  for (const id of ['text', 'javascript', 'typescript', 'python', 'bash', 'json', 'yaml', 'html', 'css', 'go', 'rust', 'diff']) {
    assert.ok(ids.includes(id), `missing ${id}`)
  }
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids')
})

test('hasHighlighter reflects the registry', () => {
  assert.equal(hasHighlighter('javascript'), true)
  assert.equal(hasHighlighter('cobol'), false)
})
