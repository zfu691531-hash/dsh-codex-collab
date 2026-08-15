import { lstat, mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appModules = '/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packages = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/schemastery',
]

for (const name of packages) {
  const source = join(appModules, ...name.split('/'))
  await lstat(source)
  const target = join(root, 'node_modules', ...name.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await rm(target, { recursive: true, force: true })
  await symlink(source, target, 'dir')
  process.stdout.write(`linked ${name}\n`)
}
