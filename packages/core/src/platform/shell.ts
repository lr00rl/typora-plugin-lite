/**
 * Cross-platform shell execution.
 */

import { IS_MAC, getMountFolder } from './detect.js'

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
    return new Promise((resolve, reject) => {
      const timer = opts.timeout
        ? setTimeout(() => reject(new Error(`Shell timeout: ${cmd}`)), opts.timeout)
        : null

      window.bridge!.callHandler(
        'controller.runCommand',
        { args: cmd, cwd },
        ([success, stdout, stderr]) => {
          if (timer) clearTimeout(timer)
          success ? resolve(stdout) : reject(new Error(stderr || `Command failed: ${cmd}`))
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
    return new Promise((resolve, reject) => {
      cp.exec(
        cmd,
        { cwd, timeout: opts.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr?.toString() || err.message))
          else resolve(stdout?.toString() ?? '')
        },
      )
    })
  }

  escape(text: string): string {
    return "'" + text.replace(/'/g, "'\\''") + "'"
  }
}

export const shell: IShell = IS_MAC ? new DarwinShell() : new NodeShell()
