// Translations of what the bot shows in the chat. Text meant for Claude
// (tool results, instructions, channel messages) and logs stay in English.
//
// The language is TELEGRAM_LANG if set, else the `language` file in the
// state directory (written by /language), else English. Every process (server,
// router, hooks, helper) reads it the same way, so one switch covers them all.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { en, type Messages } from '../locales/en.ts'
import { zh } from '../locales/zh.ts'

export type Key = keyof Messages
export type Vars = Record<string, string | number | undefined>
export type T = (key: Key, vars?: Vars) => string

export const LANGUAGES = { en: 'English', zh: '中文' } as const
export type Lang = keyof typeof LANGUAGES

const TABLES: Record<Lang, Messages> = { en, zh }

/** `en`, `zh`, `zh-hans`, `zh_CN`, ... to a supported language. */
export function normalizeLang(v: string | undefined): Lang | undefined {
  const base = v?.trim().toLowerCase().split(/[-_]/)[0]
  return base && base in TABLES ? (base as Lang) : undefined
}

/**
 * Fill a template: `{name}` is replaced by vars.name; `{n:one|other}` picks
 * by whether vars.n is 1 (languages without plurals just write the word).
 */
export function fill(template: string, vars: Vars = {}): string {
  return template
    .replace(/\{(\w+):([^|{}]*)\|([^{}]*)\}/g, (_, name: string, one: string, other: string) => (Number(vars[name]) === 1 ? one : other))
    .replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] != null ? String(vars[name]) : m))
}

export function translate(lang: Lang, key: Key, vars?: Vars): string {
  return fill(TABLES[lang][key] ?? en[key], vars)
}

export const tEn: T = (key, vars) => translate('en', key, vars)

export const languageFile = (stateDir: string) => join(stateDir, 'language')

export function readLanguage(stateDir: string, env: Record<string, string | undefined> = process.env): Lang {
  const fromEnv = normalizeLang(env.TELEGRAM_LANG)
  if (fromEnv) return fromEnv
  try {
    return normalizeLang(readFileSync(languageFile(stateDir), 'utf8')) ?? 'en'
  } catch {
    return 'en'
  }
}

/**
 * A translator that follows the current language. Long-running processes
 * pick up a /language switch without a restart; the file is re-read only
 * when it changes.
 */
export function translator(stateDir: string): T & { lang(): Lang } {
  let cached: { mtime: number; lang: Lang } | undefined
  const lang = (): Lang => {
    if (normalizeLang(process.env.TELEGRAM_LANG)) return readLanguage(stateDir)
    let mtime = 0
    try {
      mtime = statSync(languageFile(stateDir)).mtimeMs
    } catch {
      return 'en'
    }
    if (cached?.mtime !== mtime) cached = { mtime, lang: readLanguage(stateDir) }
    return cached.lang
  }
  const t = ((key: Key, vars?: Vars) => translate(lang(), key, vars)) as T & { lang(): Lang }
  t.lang = lang
  return t
}
