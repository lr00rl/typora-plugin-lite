/**
 * A compact, dependency-free syntax highlighter for the read-only code pane.
 *
 * Typora's own fence highlighting comes from CodeMirror, which is not exposed
 * as a usable global — and bundling a real highlighter (Prism/Shiki) would add
 * hundreds of KB to a plugin whose whole job is "show the file, don't touch
 * it". So this is a small hand-rolled tokenizer covering the token classes
 * that carry most of the readability (comments, strings, numbers, keywords,
 * builtins, markup tags) for the common languages, with a generic fallback
 * (strings + numbers + the usual comment styles) for everything else.
 *
 * Tokens are emitted with CodeMirror class names (`cm-keyword`, `cm-string`,
 * …) so themes could restyle them; the pane's own CSS provides the palette.
 *
 * Pure module — no DOM, no Typora — so it is fully unit-testable.
 */

export interface Token {
  text: string
  /** Class suffix, e.g. 'keyword' → span class 'cm-keyword'. null = plain. */
  cls: string | null
}

interface LangDef {
  id: string
  label: string
  lineComments?: string[]
  blockComments?: Array<[string, string]>
  /** Quote characters that delimit strings. */
  strings?: string[]
  /** Quotes that may span newlines (JS template literals). */
  multilineStrings?: string[]
  keywords?: string[]
  builtins?: string[]
  atoms?: string[]
  /** Word (or quoted string) immediately before ':' is a property. */
  keyBeforeColon?: boolean
  /** HTML/XML-ish angle-bracket markup. */
  markup?: boolean
  /** @rules are keywords, #-words are atoms (CSS). */
  css?: boolean
  /** Line-oriented +/-/* highlighting (diff/patch). */
  diff?: boolean
  /** Line-start instructions are keywords (Dockerfile). */
  lineStartKeywords?: string[]
  number?: boolean
}

const JS_KW = ('var let const function return if else for while do switch case default break continue new delete typeof instanceof in of'
  + ' class extends super this import export from async await try catch finally throw yield static get set void').split(' ')
const JS_ATOM = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']
const TS_EXTRA = ('interface type enum namespace implements public private protected readonly abstract declare keyof infer is'
  + ' never unknown any string number boolean symbol object satisfies out override').split(' ')
const JS_BUILTIN = ('console window document globalThis process module exports require JSON Math Object Array String Number Boolean Promise'
  + ' Map Set WeakMap WeakSet Symbol BigInt Error TypeError RegExp Date fetch setTimeout setInterval clearTimeout clearInterval'
  + ' parseInt parseFloat isNaN encodeURIComponent decodeURIComponent').split(' ')

const PY_KW = ('and as assert async await break class continue def del elif else except finally for from global if import in is lambda'
  + ' nonlocal not or pass raise return try while with yield match').split(' ')
const PY_ATOM = ['True', 'False', 'None', 'Ellipsis', 'NotImplemented']
const PY_BUILTIN = ('print len range str int float bool list dict set tuple frozenset type isinstance issubclass enumerate zip map filter'
  + ' sorted reversed open input repr hash id min max sum abs any all next iter getattr setattr hasattr delattr callable'
  + ' super self cls Exception ValueError TypeError KeyError IndexError StopIteration').split(' ')

const SH_KW = ('if then else elif fi for while until do done case esac function select in time return exit local export readonly declare'
  + ' typeset unset shift source alias unalias eval exec set trap break continue cd echo printf read test').split(' ')

const C_KW = ('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict'
  + ' return short signed sizeof static struct switch typedef union unsigned void volatile while bool').split(' ')
const CPP_EXTRA = ('alignas alignof and asm bitand bitor catch class compl concept const_cast constexpr consteval constinit decltype delete'
  + ' dynamic_cast explicit export false friend mutable namespace new noexcept nullptr operator or private protected public'
  + ' reinterpret_cast requires static_assert static_cast template this thread_local throw true try typeid typename using virtual wchar_t xor'
  + ' override final').split(' ')

const JAVA_KW = ('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally'
  + ' float for goto if implements import instanceof int interface long native new package private protected public record return'
  + ' sealed short static strictfp super switch synchronized this throw throws transient try var void volatile while yield permits').split(' ')

const GO_KW = ('break case chan const continue default defer else fallthrough for func go goto if import interface map package range'
  + ' return select struct switch type var').split(' ')
const GO_BUILTIN = ('append cap close complex copy delete imag len make new panic print println real recover error nil true false iota'
  + ' string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr byte rune float32 float64 bool complex64 complex128').split(' ')

const RS_KW = ('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref'
  + ' return self Self static struct super trait type unsafe use where while macro_rules').split(' ')
const RS_ATOM = ['true', 'false', 'None', 'Some', 'Ok', 'Err']

const RUBY_KW = ('alias and begin BEGIN break case class def defined do else elsif end END ensure false for if in module next nil not or'
  + ' redo rescue retry return self super then true undef unless until when while yield attr_accessor attr_reader attr_writer require'
  + ' require_relative include extend raise puts lambda proc').split(' ')

const PHP_KW = ('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty'
  + ' enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include'
  + ' instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch'
  + ' throw trait try unset use var while xor yield true false null').split(' ')

const SQL_KW = ('select from where insert into values update set delete create alter drop table index view join inner left right full outer'
  + ' on group by order having limit offset union all distinct as and or not null is in exists between like case when then else end'
  + ' primary key foreign references unique constraint default check begin commit rollback transaction grant revoke with recursive').split(' ')
const SQL_ATOM = ['true', 'false', 'null']

const SWIFT_KW = ('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol'
  + ' public rethrows static struct subscript typealias var actor async await break case continue default defer do else fallthrough for guard'
  + ' if in repeat return switch throw try where while is as Any self super nil true false some none mutating nonmutating override weak unowned').split(' ')

const KT_KW = ('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias'
  + ' typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam'
  + ' where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline'
  + ' open operator out override private protected public reified sealed suspend tailrec vararg').split(' ')

const LUA_KW = ('and break do else elseif end false for function goto if in local nil not or repeat return then true until while').split(' ')

const HS_KW = ('case class data default deriving do else foreign if import in infix infixl infixr instance let module newtype of then type where').split(' ')

const EX_KW = ('def defmodule defprotocol defimpl defmacro defstruct defexception alias import require use do end fn case cond receive try rescue'
  + ' raise throw catch after else quote unquote super with for if unless and or not in when true false nil').split(' ')

const R_KW = ('if else repeat while function for in next break TRUE FALSE NULL NA NaN Inf library require').split(' ')

const DOCKER_KW = ('FROM RUN CMD ENTRYPOINT COPY ADD WORKDIR EXPOSE ENV ARG VOLUME USER LABEL HEALTHCHECK ONBUILD SHELL STOPSIGNAL AS').split(' ')

const GENERIC: LangDef = {
  id: 'text',
  label: 'Plain text',
  lineComments: ['#', '//'],
  blockComments: [['/*', '*/']],
  strings: ['"', "'", '`'],
  number: true,
}

function def(partial: Partial<LangDef> & { id: string; label: string }): LangDef {
  return { number: true, ...partial }
}

const LANGS: LangDef[] = [
  def({ id: 'javascript', label: 'JavaScript', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'", '`'], multilineStrings: ['`'], keywords: JS_KW, builtins: JS_BUILTIN, atoms: JS_ATOM }),
  def({ id: 'typescript', label: 'TypeScript', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'", '`'], multilineStrings: ['`'], keywords: [...JS_KW, ...TS_EXTRA], builtins: JS_BUILTIN, atoms: JS_ATOM }),
  def({ id: 'jsx', label: 'JSX', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'", '`'], multilineStrings: ['`'], keywords: JS_KW, builtins: JS_BUILTIN, atoms: JS_ATOM, markup: true }),
  def({ id: 'tsx', label: 'TSX', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'", '`'], multilineStrings: ['`'], keywords: [...JS_KW, ...TS_EXTRA], builtins: JS_BUILTIN, atoms: JS_ATOM, markup: true }),
  def({ id: 'python', label: 'Python', lineComments: ['#'], strings: ['"', "'"], keywords: PY_KW, builtins: PY_BUILTIN, atoms: PY_ATOM }),
  def({ id: 'bash', label: 'Bash / Shell', lineComments: ['#'], strings: ['"', "'", '`'], keywords: SH_KW }),
  def({ id: 'powershell', label: 'PowerShell', lineComments: ['#'], blockComments: [['<#', '#>']], strings: ['"', "'"], keywords: 'function param if else elseif for foreach while do switch break continue return try catch finally throw begin process end'.split(' ') }),
  def({ id: 'bat', label: 'Batch', lineComments: ['REM ', 'rem ', '::'], strings: ['"'], keywords: 'if else exist not errorlevel for in do goto call set setlocal endlocal echo cd md rd del copy move ren pause exit shift start'.split(' ') }),
  def({ id: 'c', label: 'C', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: C_KW, atoms: ['true', 'false', 'NULL'] }),
  def({ id: 'cpp', label: 'C++', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: [...C_KW, ...CPP_EXTRA] }),
  def({ id: 'csharp', label: 'C#', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: [...JAVA_KW, 'namespace', 'using', 'string', 'bool', 'var', 'readonly', 'get', 'set', 'value', 'partial', 'async', 'await', 'nameof', 'is'], atoms: ['true', 'false', 'null'] }),
  def({ id: 'java', label: 'Java', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: JAVA_KW, atoms: ['true', 'false', 'null'] }),
  def({ id: 'kotlin', label: 'Kotlin', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: KT_KW }),
  def({ id: 'scala', label: 'Scala', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: 'abstract case catch class def do else extends false final finally for forSome if implicit import lazy match new null object override package private protected return sealed super this throw trait true try type val var while with yield'.split(' ') }),
  def({ id: 'go', label: 'Go', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'", '`'], multilineStrings: ['`'], keywords: GO_KW, builtins: GO_BUILTIN }),
  def({ id: 'rust', label: 'Rust', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: RS_KW, atoms: RS_ATOM }),
  def({ id: 'swift', label: 'Swift', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"'], keywords: SWIFT_KW }),
  def({ id: 'zig', label: 'Zig', lineComments: ['//'], strings: ['"', "'"], keywords: 'const var fn pub return if else while for switch break continue defer errdefer comptime struct enum union error try catch async await suspend resume nosuspend usingnamespace test export extern inline noinline packed align linksection threadlocal true false null undefined unreachable and or orelse'.split(' ') }),
  def({ id: 'nim', label: 'Nim', lineComments: ['#'], blockComments: [['#[', ']#']], strings: ['"', "'"], keywords: 'proc func method template macro var let const type object enum tuple ref ptr addr cast if elif else case of when while for block break continue return yield import from include export as is isnot in notin and or not div mod shl shr xor true false nil'.split(' ') }),
  def({ id: 'ruby', label: 'Ruby', lineComments: ['#'], strings: ['"', "'", '`'], keywords: RUBY_KW, atoms: ['true', 'false', 'nil'] }),
  def({ id: 'php', label: 'PHP', lineComments: ['//', '#'], blockComments: [['/*', '*/']], strings: ['"', "'", '`'], keywords: PHP_KW }),
  def({ id: 'perl', label: 'Perl', lineComments: ['#'], strings: ['"', "'", '`'], keywords: 'my our local sub use require package if elsif else unless while until for foreach continue given when default return last next redo goto die warn eval do print say chomp shift push pop unshift splice keys values each map grep sort split join scalar defined undef'.split(' ') }),
  def({ id: 'lua', label: 'Lua', lineComments: ['--'], blockComments: [['--[[', ']]']], strings: ['"', "'"], keywords: LUA_KW }),
  def({ id: 'r', label: 'R', lineComments: ['#'], strings: ['"', "'", '`'], keywords: R_KW }),
  def({ id: 'julia', label: 'Julia', lineComments: ['#'], blockComments: [['#=', '=#']], strings: ['"', "'"], keywords: 'function end if elseif else for while do try catch finally return break continue global local const struct mutable abstract primitive type module baremodule using import export let macro quote begin true false nothing missing'.split(' ') }),
  def({ id: 'dart', label: 'Dart', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: 'abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield'.split(' ') }),
  def({ id: 'groovy', label: 'Groovy', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'", '`'], keywords: [...JAVA_KW, 'def', 'trait', 'in'] }),
  def({ id: 'clojure', label: 'Clojure', lineComments: [';'], strings: ['"'], keywords: 'def defn defmacro defmulti defmethod defprotocol defrecord deftype fn let if do loop recur quote var throw try catch finally monitor-enter monitor-exit new set! ns in-ns require use import refer when when-not if-let if-not cond condp case and or not nil true false'.split(' ') }),
  def({ id: 'haskell', label: 'Haskell', lineComments: ['--'], blockComments: [['{-', '-}']], strings: ['"', "'"], keywords: HS_KW, atoms: ['True', 'False', 'Nothing', 'Just'] }),
  def({ id: 'ocaml', label: 'OCaml', lineComments: [], blockComments: [['(*', '*)']], strings: ['"', "'"], keywords: 'and as assert begin class constraint do done downto else end exception external false for fun function functor if in include inherit initializer lazy let match method module mutable new nonrec object of open or private rec sig struct then to true try type val virtual when while with'.split(' ') }),
  def({ id: 'elixir', label: 'Elixir', lineComments: ['#'], strings: ['"', "'"], keywords: EX_KW }),
  def({ id: 'erlang', label: 'Erlang', lineComments: ['%'], strings: ['"', "'"], keywords: 'after and andalso band begin bnot bor bsl bsr bxor case catch cond div end fun if let not of or orelse query receive rem try when xor true false module export import compile define record include'.split(' ') }),
  def({ id: 'fsharp', label: 'F#', lineComments: ['//'], blockComments: [['(*', '*)']], strings: ['"', "'"], keywords: 'abstract and as assert base begin class default delegate do done downcast downto elif else end exception extern false finally fixed for fun function global if in inherit inline interface internal lazy let match member module mutable namespace new null of open or override private public rec return sig static struct then to true try type upcast use val void when while with yield'.split(' ') }),
  def({ id: 'elm', label: 'Elm', lineComments: ['--'], blockComments: [['{-', '-}']], strings: ['"', "'"], keywords: [...HS_KW, 'port', 'exposing', 'alias', 'as'], atoms: ['True', 'False'] }),
  def({ id: 'html', label: 'HTML', blockComments: [['<!--', '-->']], strings: ['"', "'"], markup: true }),
  def({ id: 'xml', label: 'XML', blockComments: [['<!--', '-->']], strings: ['"', "'"], markup: true }),
  def({ id: 'vue', label: 'Vue', blockComments: [['<!--', '-->'], ['/*', '*/']], lineComments: ['//'], strings: ['"', "'", '`'], markup: true, keywords: JS_KW, atoms: JS_ATOM }),
  def({ id: 'svelte', label: 'Svelte', blockComments: [['<!--', '-->'], ['/*', '*/']], lineComments: ['//'], strings: ['"', "'", '`'], markup: true, keywords: JS_KW, atoms: JS_ATOM }),
  def({ id: 'css', label: 'CSS', blockComments: [['/*', '*/']], strings: ['"', "'"], css: true, keyBeforeColon: true }),
  def({ id: 'scss', label: 'SCSS', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], css: true, keyBeforeColon: true }),
  def({ id: 'sass', label: 'Sass', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], css: true, keyBeforeColon: true }),
  def({ id: 'less', label: 'Less', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], css: true, keyBeforeColon: true }),
  def({ id: 'stylus', label: 'Stylus', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], css: true, keyBeforeColon: true }),
  def({ id: 'json', label: 'JSON', strings: ['"'], atoms: ['true', 'false', 'null'], keyBeforeColon: true }),
  def({ id: 'yaml', label: 'YAML', lineComments: ['#'], strings: ['"', "'"], atoms: ['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~'], keyBeforeColon: true }),
  def({ id: 'toml', label: 'TOML', lineComments: ['#'], strings: ['"', "'"], atoms: ['true', 'false'], keyBeforeColon: true }),
  def({ id: 'ini', label: 'INI / Config', lineComments: ['#', ';'], strings: ['"', "'"], keyBeforeColon: true }),
  def({ id: 'gitignore', label: 'gitignore', lineComments: ['#'], number: false }),
  def({ id: 'sql', label: 'SQL', lineComments: ['--'], blockComments: [['/*', '*/']], strings: ['"', "'", '`'], keywords: SQL_KW, atoms: SQL_ATOM }),
  def({ id: 'graphql', label: 'GraphQL', lineComments: ['#'], strings: ['"'], keywords: 'query mutation subscription fragment on schema type interface union enum input extend scalar implements'.split(' '), atoms: ['true', 'false', 'null'] }),
  def({ id: 'protobuf', label: 'Protobuf', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: 'syntax package import option message enum service rpc returns repeated optional required oneof map reserved extensions extend to max stream true false'.split(' ') }),
  def({ id: 'hcl', label: 'HCL / Terraform', lineComments: ['#', '//'], blockComments: [['/*', '*/']], strings: ['"'], keywords: 'resource data variable output locals module provider terraform backend provisioner connection lifecycle count for_each dynamic depends_on true false null'.split(' ') }),
  def({ id: 'nix', label: 'Nix', lineComments: ['#'], blockComments: [['/*', '*/']], strings: ['"', "'"], keywords: 'assert builtins derivation else if in inherit let or rec then throw with true false null import'.split(' ') }),
  def({ id: 'cmake', label: 'CMake', lineComments: ['#'], strings: ['"'], keywords: 'add_executable add_library add_subdirectory add_custom_command add_custom_target cmake_minimum_required project find_package find_library find_path include include_directories link_directories link_libraries target_link_libraries target_include_directories target_compile_definitions target_compile_options set unset option if elseif else endif foreach endforeach while endwhile function endfunction macro endmacro message return install enable_testing add_test'.split(' ') }),
  def({ id: 'dockerfile', label: 'Dockerfile', lineComments: ['#'], strings: ['"', "'"], lineStartKeywords: DOCKER_KW, keywords: DOCKER_KW }),
  def({ id: 'makefile', label: 'Makefile', lineComments: ['#'], strings: ['"', "'"], keyBeforeColon: true, keywords: 'if ifeq ifneq ifdef ifndef else endif include export unexport define endef override vpath'.split(' ') }),
  def({ id: 'gradle', label: 'Gradle', lineComments: ['//'], blockComments: [['/*', '*/']], strings: ['"', "'", '`'], keywords: [...JAVA_KW, 'def', 'plugins', 'dependencies', 'repositories', 'task'] }),
  def({ id: 'diff', label: 'Diff / Patch', diff: true, number: false }),
  def({ id: 'latex', label: 'LaTeX', lineComments: ['%'], strings: [], keywords: [] }),
  def({ id: 'rst', label: 'reStructuredText', number: false }),
  def({ id: 'org', label: 'Org', lineComments: ['#'], number: false }),
  def({ id: 'asciidoc', label: 'AsciiDoc', lineComments: ['//'], number: false }),
  def({ id: 'vim', label: 'Vim script', lineComments: ['"'], strings: ['"', "'"], keywords: 'function endfunction if elseif else endif for endfor while endwhile try catch endtry let const set setlocal setglobal execute echo echom echohl call return autocmd augroup command noremap nnoremap vnoremap inoremap cnoremap map unmap source runtime finish abort'.split(' ') }),
  def({ id: 'commonlisp', label: 'Lisp', lineComments: [';'], blockComments: [['#|', '|#']], strings: ['"'], keywords: 'defun defmacro defvar defparameter defconstant lambda let let* flet labels macrolet if when unless cond case etypecase typecase loop do do* dolist dotimes progn prog1 prog2 quote function setq setf incf decf push pop return-from block tagbody go catch throw unwind-protect handler-case handler-bind multiple-value-bind destructuring-bind defclass defgeneric defmethod defstruct deftype defpackage in-package export import use require provide car cdr cons list append mapcar reduce apply funcall t nil'.split(' ') }),
  def({ id: 'scheme', label: 'Scheme', lineComments: [';'], strings: ['"'], keywords: 'define lambda let let* letrec if cond case and or not begin do when unless quote quasiquote unquote unquote-splicing define-syntax syntax-rules let-syntax letrec-syntax delay force cons car cdr list append map for-each apply eval call-with-current-continuation call/cc display newline write read set! else true false'.split(' ') }),
]

const BY_ID = new Map(LANGS.map(d => [d.id, d]))

/** Options for the header language picker: real highlighters + plain text. */
export const HIGHLIGHT_LANGS: Array<{ id: string; label: string }> = [
  { id: 'text', label: 'Plain text' },
  ...LANGS.filter(d => d.id !== 'text').map(d => ({ id: d.id, label: d.label })),
]

export function hasHighlighter(lang: string): boolean {
  return BY_ID.has(lang)
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type ScanState =
  | { kind: 'code' }
  | { kind: 'block'; end: string }
  | { kind: 'string'; quote: string }

const WORD_RE = /[A-Za-z_$][\w$]*/y
const NUMBER_RE = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/y

/**
 * Scan string CONTENT starting at `start` (i.e. past any opening quote) until
 * the closing quote, a newline, or EOF. `end` is exclusive of the newline but
 * inclusive of the closing quote.
 */
function scanString(code: string, start: number, quote: string): { end: number; closed: boolean; hitNewline: boolean } {
  const n = code.length
  let j = start
  while (j < n) {
    const c = code[j]!
    if (c === '\\') { j += 2; continue }
    if (c === quote) return { end: j + 1, closed: true, hitNewline: false }
    if (c === '\n') return { end: j, closed: false, hitNewline: true }
    j += 1
  }
  return { end: n, closed: false, hitNewline: false }
}

/**
 * Tokenize `code` for language `lang` and split the result into lines.
 * `tokensByLine[i]` reconstructs source line i exactly when concatenated.
 * Unknown languages fall back to a generic comment/string/number scan, so
 * unusual files still get the readability basics rather than flat text.
 */
export function highlightLines(code: string, lang: string): Token[][] {
  const d = BY_ID.get(lang) ?? GENERIC

  // Explicitly chosen "Plain text" means truly flat — no token classes.
  if (lang === 'text') return code.split('\n').map(line => [{ text: line, cls: null }])

  if (d.diff) return diffLines(code)

  const lines: Token[][] = [[]]
  const push = (text: string, cls: string | null): void => {
    if (!text) return
    lines[lines.length - 1]!.push({ text, cls })
  }
  const newline = (): void => { lines.push([]) }

  const kw = new Set(d.keywords ?? [])
  const bi = new Set(d.builtins ?? [])
  const at = new Set(d.atoms ?? [])
  const strings = d.strings ?? []
  const multiline = new Set(d.multilineStrings ?? [])
  const lineComments = [...(d.lineComments ?? [])].sort((a, b) => b.length - a.length)
  const blockComments = d.blockComments ?? []

  let state: ScanState = { kind: 'code' }
  let inTag = false // markup: between '<' and '>'
  let lineStart = true // nothing but whitespace seen on this line

  const n = code.length
  let i = 0
  let plainStart = 0
  const flushPlain = (to: number): void => {
    if (to > plainStart) push(code.slice(plainStart, to), null)
  }

  while (i < n) {
    const ch = code[i]!

    // --- inside a block comment ---
    if (state.kind === 'block') {
      const endIdx = code.indexOf(state.end, i)
      if (endIdx === -1) {
        // to EOF, splitting at newlines
        let j = i
        while (j < n) {
          const nl = code.indexOf('\n', j)
          if (nl === -1) { push(code.slice(j), 'comment'); j = n; break }
          push(code.slice(j, nl), 'comment')
          newline()
          lineStart = true
          j = nl + 1
        }
        i = n
        plainStart = n
        break
      }
      const segmentEnd = endIdx + state.end.length
      let j = i
      while (true) {
        const nl = code.indexOf('\n', j)
        if (nl === -1 || nl >= segmentEnd) {
          push(code.slice(j, segmentEnd), 'comment')
          break
        }
        push(code.slice(j, nl), 'comment')
        newline()
        lineStart = true
        j = nl + 1
      }
      i = segmentEnd
      plainStart = i
      state = { kind: 'code' }
      continue
    }

    // --- continuation of a multiline string (e.g. JS template literal) ---
    if (state.kind === 'string') {
      const scan = scanString(code, i, state.quote)
      push(code.slice(i, scan.end), 'string')
      if (scan.closed) {
        state = { kind: 'code' }
        i = scan.end
      } else if (scan.hitNewline) {
        newline()
        lineStart = true
        i = scan.end + 1
      } else {
        i = scan.end // EOF inside an unterminated string
      }
      plainStart = i
      continue
    }

    // --- normal code ---
    if (ch === '\n') { flushPlain(i); newline(); lineStart = true; i += 1; plainStart = i; continue }
    if (ch === ' ' || ch === '\t') { i += 1; continue } // stay in plain run

    // line comment
    const lc = lineComments.find(p => code.startsWith(p, i))
    if (lc) {
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      flushPlain(i)
      push(code.slice(i, end), 'comment')
      i = end
      plainStart = i
      continue
    }

    // block comment start
    const bc = blockComments.find(([start]) => code.startsWith(start, i))
    if (bc) {
      state = { kind: 'block', end: bc[1] }
      continue
    }

    // string start (the opener is consumed here; continuation uses the state)
    if (strings.includes(ch)) {
      flushPlain(i)
      const scan = scanString(code, i + 1, ch)
      // A string immediately before ':' is a property key (json/yaml/toml).
      let cls: string | null = 'string'
      if (scan.closed && d.keyBeforeColon) {
        let k = scan.end
        while (k < n && (code[k] === ' ' || code[k] === '\t')) k++
        if (code[k] === ':') cls = 'property'
      }
      push(code.slice(i, scan.end), cls)
      if (scan.closed) {
        i = scan.end
      } else if (scan.hitNewline && multiline.has(ch)) {
        state = { kind: 'string', quote: ch }
        newline()
        lineStart = true
        i = scan.end + 1
      } else if (scan.hitNewline) {
        // Unterminated single-line string ends at the newline.
        newline()
        lineStart = true
        i = scan.end + 1
      } else {
        i = scan.end // EOF inside an unterminated string
      }
      plainStart = i
      continue
    }

    // css: @rules and #-words
    if (d.css && ch === '@') {
      WORD_RE.lastIndex = i + 1
      const m = WORD_RE.exec(code)
      if (m) {
        flushPlain(i)
        push(code.slice(i, WORD_RE.lastIndex), 'keyword')
        i = WORD_RE.lastIndex
        plainStart = i
        continue
      }
    }
    if (d.css && ch === '#') {
      const m = /#(?:[0-9a-fA-F]{3,8}|[A-Za-z_][\w-]*)/y.exec(code)
      if (m && m.index === i) {
        flushPlain(i)
        push(m[0], 'atom')
        i += m[0].length
        plainStart = i
        continue
      }
    }

    // latex: \command
    if (d.id === 'latex' && ch === '\\') {
      WORD_RE.lastIndex = i + 1
      const m = WORD_RE.exec(code)
      flushPlain(i)
      push(code.slice(i, m ? WORD_RE.lastIndex : i + 1), 'keyword')
      i = m ? WORD_RE.lastIndex : i + 1
      plainStart = i
      continue
    }

    // markup: tags
    if (d.markup && ch === '<' && /[A-Za-z!/?]/.test(code[i + 1] ?? '')) {
      flushPlain(i)
      let j = i + 1
      if (code[j] === '/' || code[j] === '!' || code[j] === '?') j += 1
      WORD_RE.lastIndex = j
      const m = WORD_RE.exec(code)
      if (m) j = WORD_RE.lastIndex
      push(code.slice(i, j), 'tag')
      inTag = true
      i = j
      plainStart = i
      continue
    }
    if (d.markup && inTag && ch === '>') {
      flushPlain(i)
      push('>', 'tag')
      inTag = false
      i += 1
      plainStart = i
      continue
    }
    if (d.markup && inTag) {
      WORD_RE.lastIndex = i
      const m = WORD_RE.exec(code)
      if (m) {
        // attribute name (followed by =) vs plain word
        let k = WORD_RE.lastIndex
        while (k < n && (code[k] === ' ' || code[k] === '\t')) k++
        flushPlain(i)
        push(m[0], code[k] === '=' ? 'attribute' : null)
        i = WORD_RE.lastIndex
        plainStart = i
        continue
      }
    }

    // number
    if (d.number !== false && /\d/.test(ch)) {
      NUMBER_RE.lastIndex = i
      const m = NUMBER_RE.exec(code)
      if (m && m.index === i) {
        flushPlain(i)
        push(m[0], 'number')
        i += m[0].length
        plainStart = i
        continue
      }
    }

    // word: keyword / builtin / atom / property / plain
    if (/[A-Za-z_$]/.test(ch)) {
      WORD_RE.lastIndex = i
      const m = WORD_RE.exec(code)
      if (m && m.index === i) {
        const word = m[0]
        let cls: string | null = null
        if (lineStart && d.lineStartKeywords && d.lineStartKeywords.includes(word.toUpperCase())) cls = 'keyword'
        else if (kw.has(word) || kw.has(word.toLowerCase())) cls = 'keyword'
        else if (bi.has(word)) cls = 'builtin'
        else if (at.has(word)) cls = 'atom'
        else if (d.keyBeforeColon) {
          let k = WORD_RE.lastIndex
          while (k < n && (code[k] === ' ' || code[k] === '\t')) k++
          if (code[k] === ':') cls = 'property'
        }
        flushPlain(i)
        push(word, cls)
        lineStart = false
        i = WORD_RE.lastIndex
        plainStart = i
        continue
      }
    }

    lineStart = false
    i += 1
  }

  flushPlain(n)
  return lines
}

/** Line-oriented highlighting for .diff/.patch. */
function diffLines(code: string): Token[][] {
  return code.split('\n').map(line => {
    let cls: string | null = null
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'meta'
    else if (line.startsWith('+')) cls = 'string'
    else if (line.startsWith('-')) cls = 'tag'
    else if (line.startsWith('@@')) cls = 'keyword'
    else if (/^(diff|index|new file|deleted file|old mode|new mode|similarity|rename)/.test(line)) cls = 'meta'
    return [{ text: line, cls }]
  })
}
