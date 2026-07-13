import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/build.yml', 'utf8')
const lines = workflow.replaceAll('\r\n', '\n').split('\n')

interface MappingLine {
  lineNumber: number
  indent: number
  key: string
  value: string
  sequenceItem: boolean
}

function parseMappingLine(line: string, lineNumber: number): MappingLine | null {
  if (line.trim() === '' || line.trimStart().startsWith('#')) return null
  const indent = line.length - line.trimStart().length
  const trimmed = line.trimStart()
  const sequenceItem = trimmed.startsWith('- ')
  const mappingText = sequenceItem ? trimmed.slice(2) : trimmed
  const match = mappingText.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/)
  if (!match) return null
  return {
    lineNumber,
    indent,
    key: match[1],
    value: match[2] ?? '',
    sequenceItem,
  }
}

function validateWorkflowYaml(source: string): string[] {
  const errors: string[] = []
  const sourceLines = source.replaceAll('\r\n', '\n').split('\n')
  let blockScalarOwnerIndent: number | null = null
  let previousIndent = 0
  let sawContent = false

  sourceLines.forEach((line, index) => {
    const lineNumber = index + 1
    if (line.includes('\t')) errors.push(`line ${lineNumber}: tabs are not valid indentation`)
    if (/\s+$/.test(line) && line.trim() !== '') errors.push(`line ${lineNumber}: trailing whitespace`)
    if (line.trim() === '' || line.trimStart().startsWith('#')) return

    const indent = line.length - line.trimStart().length
    if (blockScalarOwnerIndent != null && indent > blockScalarOwnerIndent) return
    blockScalarOwnerIndent = null

    if (indent % 2 !== 0) errors.push(`line ${lineNumber}: indentation must use two-space levels`)
    if (sawContent && indent > previousIndent + 2) {
      errors.push(`line ${lineNumber}: indentation jumps more than one level`)
    }

    const mapping = parseMappingLine(line, lineNumber)
    if (!mapping) {
      errors.push(`line ${lineNumber}: expected a mapping key or mapping sequence item`)
      previousIndent = indent
      sawContent = true
      return
    }

    const bracketDelta = [...mapping.value].reduce((balance, char) => {
      if (char === '[') return balance + 1
      if (char === ']') return balance - 1
      return balance
    }, 0)
    if (bracketDelta !== 0) errors.push(`line ${lineNumber}: unbalanced inline sequence brackets`)
    if (mapping.value === '|' || mapping.value === '>') blockScalarOwnerIndent = indent
    previousIndent = indent
    sawContent = true
  })

  const topLevelKeys = sourceLines
    .map((line, index) => parseMappingLine(line, index + 1))
    .filter((entry): entry is MappingLine => entry != null && entry.indent === 0 && !entry.sequenceItem)
    .map(entry => entry.key)
  if (new Set(topLevelKeys).size !== topLevelKeys.length) errors.push('duplicate top-level mapping key')
  for (const required of ['name', 'on', 'jobs']) {
    if (!topLevelKeys.includes(required)) errors.push(`missing top-level ${required} key`)
  }

  return errors
}

function findBlock(key: string, indent: number, within = lines): string[] {
  const start = within.findIndex((line, index) => {
    const mapping = parseMappingLine(line, index + 1)
    return mapping?.indent === indent && !mapping.sequenceItem && mapping.key === key
  })
  if (start < 0) throw new Error(`Missing ${' '.repeat(indent)}${key} block`)

  let end = within.length
  for (let index = start + 1; index < within.length; index++) {
    const line = within[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const nextIndent = line.length - line.trimStart().length
    if (nextIndent <= indent) {
      end = index
      break
    }
  }
  return within.slice(start + 1, end)
}

function directMappings(block: string[], indent: number): Map<string, string> {
  const entries = block
    .map((line, index) => parseMappingLine(line, index + 1))
    .filter((entry): entry is MappingLine => entry != null && entry.indent === indent && !entry.sequenceItem)
  return new Map(entries.map(entry => [entry.key, entry.value]))
}

function inlineList(value: string | undefined): string[] {
  if (!value) return []
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [trimmed.replace(/^['"]|['"]$/g, '')]
  return trimmed
    .slice(1, -1)
    .split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

describe('release workflow CI gates', () => {
  it('remains structurally valid YAML for the workflow subset in use', () => {
    expect(validateWorkflowYaml(workflow)).toEqual([])
  })

  it('preserves push branch/tag and manual triggers while adding pull requests', () => {
    const onBlock = findBlock('on', 0)
    const triggers = directMappings(onBlock, 2)
    expect([...triggers.keys()].sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])

    const pushBlock = findBlock('push', 2, onBlock)
    const push = directMappings(pushBlock, 4)
    expect(new Set(inlineList(push.get('branches')))).toEqual(new Set(['master', 'main']))
    expect(inlineList(push.get('tags'))).toEqual(['v*'])

    const pullRequestBlock = findBlock('pull_request', 2, onBlock)
    const pullRequest = directMappings(pullRequestBlock, 4)
    expect(new Set(inlineList(pullRequest.get('branches')))).toEqual(new Set(['master', 'main']))
    expect(triggers.has('workflow_dispatch')).toBe(true)
  })

  it('preserves all build, packaged E2E, and release jobs', () => {
    const jobsBlock = findBlock('jobs', 0)
    const jobs = directMappings(jobsBlock, 2)
    expect(new Set(jobs.keys())).toEqual(new Set([
      'build-mac',
      'e2e-mac',
      'e2e-win',
      'release-win',
      'release-mac',
    ]))
  })

  it('blocks each tagged release until its packaged platform E2E job passes', () => {
    const jobsBlock = findBlock('jobs', 0)
    const releaseWin = directMappings(findBlock('release-win', 2, jobsBlock), 4)
    const releaseMac = directMappings(findBlock('release-mac', 2, jobsBlock), 4)

    expect(inlineList(releaseWin.get('needs'))).toEqual(['e2e-win'])
    expect(inlineList(releaseMac.get('needs'))).toEqual(['e2e-mac'])
    expect(releaseWin.get('if')).toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(releaseMac.get('if')).toContain("startsWith(github.ref, 'refs/tags/v')")
  })
})
