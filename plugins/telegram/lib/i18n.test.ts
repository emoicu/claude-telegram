import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { en } from '../locales/en'
import { zh } from '../locales/zh'
import { fill, languageFile, normalizeLang, readLanguage, translate, translator } from './i18n'

const vars = (s: string) =>
  [...s.matchAll(/\{(\w+)(?::[^{}]*)?\}/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort()

describe('locales', () => {
  test('every language has every key, with the same placeholders', () => {
    for (const [key, text] of Object.entries(en)) {
      const other = (zh as Record<string, string>)[key]
      expect(other, key).toBeTruthy()
      expect(vars(other!), key).toEqual(vars(text))
    }
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('fill', () => {
  test('placeholders and plurals', () => {
    expect(fill('{n} {n:step|steps}', { n: 1 })).toBe('1 step')
    expect(fill('{n} {n:step|steps}', { n: 3 })).toBe('3 steps')
    expect(fill('Hi {name}, {missing}', { name: 'Ann' })).toBe('Hi Ann, {missing}')
    expect(fill('Cost: ${cost}', { cost: '1.50' })).toBe('Cost: $1.50')
  })
  test('translate falls back to the template language', () => {
    expect(translate('zh', 'statusSteps', { n: 2 })).toBe('2 步')
    expect(translate('en', 'statusSteps', { n: 2 })).toBe('2 steps')
  })
})

describe('language setting', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-i18n-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('normalizeLang', () => {
    expect(normalizeLang('zh-hans')).toBe('zh')
    expect(normalizeLang('ZH_CN')).toBe('zh')
    expect(normalizeLang('en-US')).toBe('en')
    expect(normalizeLang('fr')).toBeUndefined()
    expect(normalizeLang(undefined)).toBeUndefined()
  })

  test('environment, then the language file, then English', () => {
    expect(readLanguage(dir, {})).toBe('en')
    writeFileSync(languageFile(dir), 'zh\n')
    expect(readLanguage(dir, {})).toBe('zh')
    expect(readLanguage(dir, { TELEGRAM_LANG: 'en' })).toBe('en')
    writeFileSync(languageFile(dir), 'klingon\n')
    expect(readLanguage(dir, {})).toBe('en')
  })

  test('a translator follows a switch without a restart', () => {
    const t = translator(dir)
    expect(t('permAllow')).toBe('✅ Allow')
    writeFileSync(languageFile(dir), 'zh\n')
    expect(t('permAllow')).toBe('✅ 允许')
    expect(t.lang()).toBe('zh')
    writeFileSync(languageFile(dir), 'en\n')
    // Same-second writes can share an mtime; make the change visible.
    utimesSync(languageFile(dir), new Date(), new Date(Date.now() + 5000))
    expect(t('permAllow')).toBe('✅ Allow')
  })
})
