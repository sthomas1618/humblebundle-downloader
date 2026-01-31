import { spawn } from 'node:child_process'

export async function runCommand(
  command: string,
  commandArguments: string[],
  stdio: 'inherit' | 'ignore' = 'inherit'
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArguments, { stdio })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `Command failed (${command} ${commandArguments.join(' ')}): exit code ${code ?? ''}`
        )
      )
    })
  })
}

export async function commandExists(command: string): Promise<boolean> {
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'cmd' : 'sh'
  const commandArguments = isWindows ? ['/c', `where ${command}`] : ['-c', `command -v ${command}`]

  return await new Promise<boolean>((resolve) => {
    const child = spawn(shell, commandArguments, { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}
