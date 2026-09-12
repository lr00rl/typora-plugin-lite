function slash(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function resolveThemesDir(opts: {
  isMac: boolean
  homedir: string
  userPath?: string
  currentThemeFolder?: string
  userDataPath?: string
  nodePlatform?: string
  appData?: string
}): string {
  if (opts.currentThemeFolder) {
    return slash(opts.currentThemeFolder)
  }
  if (opts.userDataPath) {
    return `${slash(opts.userDataPath)}/themes`
  }

  const home = slash(opts.homedir)
  if (opts.isMac) {
    return `${home}/Library/Application Support/abnerworks.Typora/themes`
  }

  const userPath = opts.userPath ? slash(opts.userPath) : ''
  if (userPath && userPath !== home) {
    return `${userPath}/themes`
  }

  if (opts.nodePlatform === 'win32') {
    const appData = opts.appData ? slash(opts.appData) : `${home}/AppData/Roaming`
    return `${appData}/Typora/themes`
  }

  return `${home}/.config/Typora/themes`
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
}

export function pathToFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(normalized)) {
    const drive = normalized.slice(0, 2)
    const rest = normalized.slice(3).split('/').filter(Boolean).map(encodeURIComponent).join('/')
    return `file:///${drive}/${rest}`
  }
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${prefixed.split('/').map((segment, index) => (
    index === 0 ? segment : encodeURIComponent(segment)
  )).join('/')}`
}
