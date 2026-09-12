export const DEFAULT_THEME_SOURCE = 'https://github.com/lr00rl/Typora_Claude-Like_Theme'
export const DEFAULT_THEME_REF = 'main'
export const PACK_MANIFEST = 'theme-pack.json'

export type GitHubSource = {
  kind: 'github'
  owner: string
  repo: string
  ref: string
}

export type LocalSource = {
  kind: 'local'
  dir: string
}

export type ThemeSource = GitHubSource | LocalSource

const GITHUB_REPO = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i
const GITHUB_TREE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)/i
const GITHUB_RAW = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)/i
const SHORT_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/

export function expandHome(input: string, homedir: string): string {
  if (input === '~') return homedir
  if (input.startsWith('~/')) return `${homedir.replace(/[\\/]+$/, '')}/${input.slice(2)}`
  return input
}

export function parseThemeSource(raw: string, opts: { ref?: string; homedir: string }): ThemeSource {
  const trimmed = raw.trim()
  if (!trimmed) return parseThemeSource(DEFAULT_THEME_SOURCE, opts)
  if (/^(javascript|data):/i.test(trimmed)) {
    throw new Error(`unsupported theme source: ${trimmed}`)
  }

  const ref = (opts.ref ?? DEFAULT_THEME_REF).trim() || DEFAULT_THEME_REF
  const tree = trimmed.match(GITHUB_TREE)
  if (tree) {
    return github(tree[1]!, tree[2]!, decodeURIComponent(tree[3]!))
  }
  const rawMatch = trimmed.match(GITHUB_RAW)
  if (rawMatch) {
    return github(rawMatch[1]!, rawMatch[2]!, decodeURIComponent(rawMatch[3]!))
  }
  const repoUrl = trimmed.match(GITHUB_REPO)
  if (repoUrl) {
    return github(repoUrl[1]!, repoUrl[2]!, ref)
  }
  const short = trimmed.match(SHORT_REPO)
  if (
    short
    && !trimmed.includes('\\')
    && !trimmed.startsWith('/')
    && !trimmed.startsWith('.')
    && !/^[A-Za-z]:/.test(trimmed)
  ) {
    return github(short[1]!, short[2]!, ref)
  }

  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error('theme-pack source must be a GitHub repository (https://github.com/owner/repo)')
  }

  const expanded = expandHome(trimmed.replace(/^file:\/\//, ''), opts.homedir)
    .replace(/[\\/]+$/, '')
  return { kind: 'local', dir: expanded }
}

export function githubRawUrl(source: GitHubSource, path: string): string {
  const ref = encodeURIComponent(source.ref).replace(/%2F/gi, '/')
  const file = path.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${ref}/${file}`
}

function github(owner: string, repo: string, ref: string): GitHubSource {
  return { kind: 'github', owner, repo: repo.replace(/\.git$/i, ''), ref }
}
