/**
 * Cross-platform shell execution.
 */

import { IS_MAC, getMountFolder } from './detect.js'
const TAG = '[tpl:shell]'

export interface ShellResult {
  success: boolean
  stdout: string
  stderr: string
}

export interface IShell {
  run(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<string>
  escape(text: string): string
}

class DarwinShell implements IShell {
  run(cmd: string, opts: { cwd?: string; timeout?: number } = {}): Promise<string> {
    const cwd = opts.cwd ?? getMountFolder()
    console.log(TAG, 'run:start', { cmd, cwd, timeout: opts.timeout ?? null, platform: 'darwin' })
    return new Promise((resolve, reject) => {
      const timer = opts.timeout
        ? setTimeout(() => reject(new Error(`Shell timeout: ${cmd}`)), opts.timeout)
        : null

      window.bridge!.callHandler(
        'controller.runCommand',
        { args: cmd, cwd },
        ([success, stdout, stderr]) => {
          if (timer) clearTimeout(timer)
          if (success) {
            console.log(TAG, 'run:success', {
              cmd,
              cwd,
              stdoutPreview: stdout.slice(0, 300),
              stdoutLength: stdout.length,
            })
            resolve(stdout)
          } else {
            console.error(TAG, 'run:failure', {
              cmd,
              cwd,
              stderrPreview: stderr.slice(0, 300),
              stderrLength: stderr.length,
            })
            reject(new Error(stderr || `Command failed: ${cmd}`))
          }
        },
      )
    })
  }

  escape(text: string): string {
    return "'" + text.replace(/'/g, "'\\''") + "'"
  }
}

class NodeShell implements IShell {
  run(cmd: string, opts: { cwd?: string; timeout?: number } = {}): Promise<string> {
    const cp = window.reqnode!('child_process')
    const cwd = opts.cwd ?? getMountFolder()
    console.log(TAG, 'run:start', { cmd, cwd, timeout: opts.timeout ?? 30_000, platform: 'node' })
    return new Promise((resolve, reject) => {
      cp.exec(
        cmd,
        { cwd, timeout: opts.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            console.error(TAG, 'run:failure', {
              cmd,
              cwd,
              stderrPreview: stderr?.toString().slice(0, 300),
              stderrLength: stderr?.toString().length ?? 0,
              error: err.message,
            })
            reject(new Error(stderr?.toString() || err.message))
          } else {
            const out = stdout?.toString() ?? ''
            console.log(TAG, 'run:success', {
              cmd,
              cwd,
              stdoutPreview: out.slice(0, 300),
              stdoutLength: out.length,
            })
            resolve(out)
          }
        },
      )
    })
  }

  escape(text: string): string {
    return "'" + text.replace(/'/g, "'\\''") + "'"
  }
}

export const shell: IShell = IS_MAC ? new DarwinShell() : new NodeShell()
