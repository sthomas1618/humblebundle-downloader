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

export async function runCommandOutput(
  command: string,
  commandArguments: string[]
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, commandArguments, { stdio: ['ignore', 'pipe', 'pipe'] })
    const output: Buffer[] = []
    const errors: Buffer[] = []

    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)))
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(output).toString('utf8'))
        return
      }
      const stderr = Buffer.concat(errors).toString('utf8').trim()
      const suffix = stderr ? `\n${stderr}` : ''
      reject(
        new Error(
          `Command failed (${command} ${commandArguments.join(' ')}): exit code ${code ?? ''}${suffix}`
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
