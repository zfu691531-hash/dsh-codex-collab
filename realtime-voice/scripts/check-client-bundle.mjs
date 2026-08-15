import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
if (!/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']dsh-realtime-voice["']/.test(source)) {
  throw new Error('client bundle is missing the DSH module-loader wrapper')
}
for (const forbidden of ['node:fs', 'node:path', 'node:http', 'credentialRef(']) {
  if (source.includes(forbidden)) throw new Error(`client bundle leaked forbidden token: ${forbidden}`)
}
process.stdout.write('client bundle purity OK\n')
