/**
 * Filename → fenced-code-block language, for the read-only code viewer.
 *
 * The returned tag is what goes after the opening ``` — the same identifier you
 * would type in a Typora fence — so CodeMirror picks the right highlighter. An
 * unknown-but-textual file still opens (returns '' → an untagged code block,
 * i.e. plain monospace, no markdown mis-parsing), which is the whole point.
 *
 * Markdown itself is deliberately excluded: those are real Typora documents and
 * must open normally, editable.
 */

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])

/** Extensions matched by their full basename rather than a dotted suffix. */
const FILENAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  cmakelists: 'cmake',
  '.gitignore': 'gitignore',
  '.gitattributes': 'ini',
  '.env': 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.vimrc': 'vim',
}

const EXT_LANG: Record<string, string> = {
  // scripting
  py: 'python', pyw: 'python', pyi: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  rb: 'ruby', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua',
  r: 'r', jl: 'julia', dart: 'dart', groovy: 'groovy', tcl: 'tcl',
  // shell
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ksh: 'bash',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  // systems
  c: 'c', h: 'c',
  cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', swift: 'swift', zig: 'zig', nim: 'nim',
  // jvm
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', clj: 'clojure', cljs: 'clojure', groovy2: 'groovy',
  // functional
  hs: 'haskell', ml: 'ocaml', ex: 'elixir', exs: 'elixir', erl: 'erlang', fs: 'fsharp', elm: 'elm',
  // web
  html: 'html', htm: 'html', xhtml: 'html', vue: 'vue', svelte: 'svelte',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', styl: 'stylus',
  // data / config
  json: 'json', json5: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', svg: 'xml', plist: 'xml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  // build / infra
  tf: 'hcl', hcl: 'hcl', nix: 'nix', cmake: 'cmake', gradle: 'groovy',
  dockerignore: 'gitignore',
  // markup / docs (non-md text)
  tex: 'latex', rst: 'rst', org: 'org', adoc: 'asciidoc',
  csv: 'text', tsv: 'text', log: 'text', txt: 'text', text: 'text',
  diff: 'diff', patch: 'diff',
  // vim / emacs / misc
  vim: 'vim', el: 'commonlisp', lisp: 'commonlisp', scm: 'scheme',
}

function splitExt(fileName: string): { base: string; ext: string } {
  const name = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, ext: '' } // no ext, or dotfile like ".env"
  return { base: name, ext: name.slice(dot + 1) }
}

/** True for Typora's own document types, which must never be code-viewed. */
export function isMarkdownFile(fileName: string): boolean {
  const { ext } = splitExt(fileName)
  return MARKDOWN_EXTS.has(ext.toLowerCase())
}

/**
 * The fence language for this filename, or null if it should NOT be code-viewed
 * (markdown, or no filename). An unknown textual extension returns '' — open it
 * as an untagged (plain) code block rather than refusing.
 */
export function languageFor(fileName: string): string | null {
  const { base, ext } = splitExt(fileName)
  if (!base) return null
  if (isMarkdownFile(fileName)) return null

  const lowerBase = base.toLowerCase()
  if (lowerBase in FILENAME_LANG) return FILENAME_LANG[lowerBase]!

  const lowerExt = ext.toLowerCase()
  if (!lowerExt) {
    // Dotfiles / extension-less files: treat as plain text so they still open.
    return ''
  }
  return EXT_LANG[lowerExt] ?? ''
}
