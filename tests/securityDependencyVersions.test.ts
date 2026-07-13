import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('security runtime dependency pins', () => {
  const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
  const workflowSource = readFileSync(resolve(process.cwd(), '.github/workflows/build.yml'), 'utf8')
  const nodeVersions = (source: string) => [...source.matchAll(/node-version:\s*['"]?([^'"\s]+)['"]?/g)]
    .map(match => match[1])

  it('pins the reviewed runtime and packaging versions exactly', () => {
    expect(packageJson.dependencies).toMatchObject({
      firebase: '12.16.0',
      uuid: '11.1.1',
      'electron-updater': '^6.8.9',
    })
    expect(packageJson.devDependencies).toMatchObject({
      electron: '43.1.0',
      'electron-builder': '26.15.3',
    })
    expect(packageJson.devDependencies).not.toHaveProperty('@types/uuid')
  })

  it('does not fold the nonblocking Vite and Vitest majors into this security change', () => {
    expect(packageJson.devDependencies.vite).toBe('^5.3.3')
    expect(packageJson.devDependencies.vitest).toBe('^1.6.0')
  })

  it('keeps every setup-node job on the exact Electron 43 bundled Node version', () => {
    const expectedVersions = Array(7).fill('24.18.0')

    expect(nodeVersions(workflowSource)).toEqual(expectedVersions)

    const node20Mutation = workflowSource.replace("node-version: '24.18.0'", "node-version: '20'")
    expect(nodeVersions(node20Mutation)).not.toEqual(expectedVersions)
    expect(nodeVersions(node20Mutation)).toContain('20')
  })
})
