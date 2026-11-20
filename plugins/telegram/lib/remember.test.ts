import { describe as group, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addPending,
  addRemembered,
  allowOutput,
  describe,
  findPending,
  loadList,
  markAnswered,
  matchRemembered,
  PENDING_TTL_MS,
  type PendingPrompt,
  promptKey,
  REMEMBER_TTL_MS,
  type Remembered,
  rememberable,
  saveList,
  type Suggestion,
} from './remember'

const dirs = (d: string): Suggestion => ({ type: 'addDirectories', directories: [d], destination: 'session' })
const rule = (content: string): Suggestion => ({
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: content }],
  behavior: 'allow',
  destination: 'localSettings',
})
const prompt = (over: Partial<PendingPrompt> = {}): PendingPrompt => ({
  at: 0,
  session: 's1',
  tool: 'Bash',
  input: '{"command":"npm run test"}',
  suggestions: [rule('npm run test *')],
  ...over,
})

group('rememberable', () => {
  test('keeps allow rules and directories, never mode changes or deny rules', () => {
    const keep = rememberable([
      rule('ls *'),
      dirs('/tmp/x'),
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { ...rule('rm *'), behavior: 'deny' },
    ])
    expect(keep.map(s => s.type)).toEqual(['addRules', 'addDirectories'])
  })
})

group('describe', () => {
  test('lists rules and directories', () => {
    expect(describe([rule('npm run test *'), dirs('/srv')])).toBe('Bash(npm run test *), access to /srv')
  })
})

group('promptKey', () => {
  test('same suggestions give the same key whatever the exact command', () => {
    expect(promptKey('Bash', '{"command":"npm run test a"}', [rule('npm run test *')])).toBe(
      promptKey('Bash', '{"command":"npm run test b"}', [rule('npm run test *')]),
    )
  })
  test('the destination does not matter', () => {
    expect(promptKey('Bash', '{}', [{ ...rule('x *'), destination: 'session' }])).toBe(promptKey('Bash', '{}', [rule('x *')]))
  })
  test('without suggestions only the exact same call matches', () => {
    expect(promptKey('WebFetch', '{"url":"a"}', [])).not.toBe(promptKey('WebFetch', '{"url":"b"}', []))
    expect(promptKey('WebFetch', '{"url":"a"}', [{ type: 'setMode', mode: 'acceptEdits' }])).toBe('exact:WebFetch:{"url":"a"}')
  })
})

group('findPending', () => {
  test('matches the tool and the input preview, newest first', () => {
    const list: PendingPrompt[] = []
    addPending(list, prompt({ at: 1, input: '{"command":"ls"}' }), 1)
    addPending(list, prompt({ at: 2, input: '{"command":"npm run test"}' }), 2)
    addPending(list, prompt({ at: 3, tool: 'Write', input: '{"file_path":"/a"}' }), 3)
    expect(findPending(list, 'Bash', '{"command":"ls"}', 10)?.at).toBe(1)
    expect(findPending(list, 'Bash', '{"command":"npm ru…', 10)?.at).toBe(2)
  })
  test('falls back to the only fresh prompt of that tool', () => {
    const list = addPending([], prompt({ at: 5 }), 5)
    expect(findPending(list, 'Bash', 'npm run test', 10)?.at).toBe(5)
    expect(findPending(list, 'Write', 'x', 10)).toBeUndefined()
  })
  test('answered prompts are never matched again, not even by the fallback', () => {
    const list = addPending([], prompt({ at: 5 }), 5)
    const p = findPending(list, 'Bash', '{"command":"npm run test"}', 10)!
    markAnswered(list, p, 11)
    expect(list[0]!.answered).toBe(11)
    expect(findPending(list, 'Bash', '{"command":"npm run test"}', 12)).toBeUndefined()
    expect(findPending(list, 'Bash', 'formatted differently', 12)).toBeUndefined()
    // A new prompt for the same tool is the only candidate left.
    addPending(list, prompt({ at: 20, input: '{"command":"ls"}' }), 20)
    expect(findPending(list, 'Bash', 'formatted differently', 21)?.at).toBe(20)
    // The mark survives the store.
    const file = join(mkdtempSync(join(tmpdir(), 'remember-test-')), 'pending-main.json')
    saveList(file, list)
    expect(findPending(loadList<PendingPrompt>(file), 'Bash', 'npm run test', 22)?.at).toBe(20)
  })
  test('markAnswered ignores a prompt that is not in the list', () => {
    const list = addPending([], prompt({ at: 5 }), 5)
    markAnswered(list, prompt({ at: 5 }), 6)
    expect(list[0]!.answered).toBeUndefined()
  })
  test('expired prompts are dropped', () => {
    const list = addPending([], prompt({ at: 0 }), 0)
    expect(findPending(list, 'Bash', '{"command":"npm run test"}', PENDING_TTL_MS)).toBeUndefined()
    addPending(list, prompt({ at: PENDING_TTL_MS, input: '{"command":"pwd"}' }), PENDING_TTL_MS)
    expect(list).toHaveLength(1)
  })
})

group('remembered answers', () => {
  test('cover the same kind of prompt in the same conversation only', () => {
    const list = addRemembered([], prompt(), 0)
    expect(list[0]!.label).toBe('Bash(npm run test *)')
    const later = '{"command":"npm run test --watch"}'
    expect(matchRemembered(list, 's1', 'Bash', later, [rule('npm run test *')], 1000)).toBeDefined()
    expect(matchRemembered(list, 's2', 'Bash', later, [rule('npm run test *')], 1000)).toBeUndefined()
    expect(matchRemembered(list, 's1', 'Bash', '{"command":"rm -rf /"}', [rule('rm -rf *')], 1000)).toBeUndefined()
  })
  test('an extra directory allowed for one tool does not allow another tool there', () => {
    const read = prompt({ tool: 'Read', input: '{"file_path":"/etc/hosts"}', suggestions: [dirs('/etc')] })
    const list = addRemembered([], read, 0)
    expect(matchRemembered(list, 's1', 'Read', '{"file_path":"/etc/passwd"}', [dirs('/etc')], 1)).toBeDefined()
    for (const tool of ['Write', 'Edit', 'Bash']) {
      expect(matchRemembered(list, 's1', tool, '{"file_path":"/etc/passwd"}', [dirs('/etc')], 1)).toBeUndefined()
    }
    expect(promptKey('Read', '{}', [dirs('/etc')])).not.toBe(promptKey('Write', '{}', [dirs('/etc')]))
  })
  test('expire after a day and are not duplicated', () => {
    const list = addRemembered([], prompt(), 0)
    addRemembered(list, prompt(), 10)
    expect(list).toHaveLength(1)
    expect(matchRemembered(list, 's1', 'Bash', '{}', [rule('npm run test *')], REMEMBER_TTL_MS + 10)).toBeUndefined()
  })
  test('a prompt without suggestions is remembered as the exact call', () => {
    const p = prompt({ tool: 'WebFetch', input: '{"url":"https://example.com"}', suggestions: [] })
    const list = addRemembered([], p, 0)
    expect(list[0]!.label).toBe('this exact WebFetch call: {"url":"https://example.com"}')
    expect(matchRemembered(list, 's1', 'WebFetch', '{"url":"https://example.com"}', [], 1)).toBeDefined()
    expect(matchRemembered(list, 's1', 'WebFetch', '{"url":"https://other.com"}', [], 1)).toBeUndefined()
  })
})

group('allowOutput', () => {
  test('allows and passes the suggestions on as session rules', () => {
    expect(allowOutput([rule('npm run test *'), { type: 'setMode', mode: 'acceptEdits' }])).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ ...rule('npm run test *'), destination: 'session' }],
        },
      },
    })
  })
  test('plain allow when there is nothing to pass on', () => {
    expect(allowOutput([])).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  })
})

group('stores', () => {
  test('round-trip and tolerate missing or broken files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'remember-test-'))
    const file = join(dir, 'permissions', 'remembered-main.json')
    expect(loadList(file)).toEqual([])
    const list: Remembered[] = addRemembered([], prompt(), 0)
    saveList(file, list)
    expect(loadList<Remembered>(file)).toEqual(list)
  })
})
