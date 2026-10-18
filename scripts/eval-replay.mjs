#!/usr/bin/env node
/**
 * Dev-only replay evaluator.
 *
 * It uses the shipped prompt builder, parser, and ranking, then compares the
 * candidates with the user message that actually followed the turn.
 *
 *   # inspect prompts without spending tokens
 *   node scripts/eval-replay.mjs --dry-run
 *
 *   # score with any OpenAI-compatible endpoint
 *   $env:EVAL_BASE_URL="https://api.deepseek.com"
 *   $env:EVAL_API_KEY="..."
 *   $env:EVAL_MODEL="deepseek-chat"
 *   node scripts/eval-replay.mjs
 *
 *   # replay recorded model answers instead
 *   node scripts/eval-replay.mjs --responses scripts/golden/responses.json
 *
 * Cases exported from a real session log may contain private text; keep them
 * out of git (scripts/golden/session-*.json is ignored).
 */
import fs from 'node:fs'
import path from 'node:path'
import { __testing } from '../lib/index.js'

const { buildContext, buildPrompt, parseCandidates, rankCandidates, mentions } = __testing

function parseArgs(argv) {
  const options = {
    cases: path.join('scripts', 'golden', 'cases.json'),
    responses: '',
    dryRun: false,
    limit: 0,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--cases') options.cases = argv[++index]
    else if (arg === '--responses') options.responses = argv[++index]
    else if (arg === '--limit') options.limit = Number(argv[++index]) || 0
  }
  return options
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function bigrams(text) {
  const out = new Set()
  for (let index = 0; index < text.length - 1; index += 1) out.add(text.slice(index, index + 2))
  return out
}

function similarity(left, right) {
  const a = normalize(left)
  const b = normalize(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const shorter = Math.min(a.length, b.length)
  const longer = Math.max(a.length, b.length)
  if (shorter >= 4 && (a.includes(b) || b.includes(a))) return shorter / longer
  const ba = bigrams(a)
  const bb = bigrams(b)
  if (ba.size === 0 || bb.size === 0) return 0
  let shared = 0
  for (const gram of ba) if (bb.has(gram)) shared += 1
  return shared / (ba.size + bb.size - shared)
}

function bestSimilarity(candidates, actual) {
  return candidates.reduce((best, candidate) => Math.max(best, similarity(candidate, actual)), 0)
}

async function providerReply(prompt, timeoutMs = 20000) {
  const base = (process.env.EVAL_BASE_URL || '').replace(/\/+$/, '')
  const key = process.env.EVAL_API_KEY
  const model = process.env.EVAL_MODEL || 'deepseek-chat'
  if (!base || !key) {
    throw new Error('Set EVAL_BASE_URL and EVAL_API_KEY, or pass --responses / --dry-run.')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        max_tokens: 150,
        temperature: 0.5,
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const data = await response.json()
    return {
      text: data?.choices?.[0]?.message?.content || '',
      tokens: Number(data?.usage?.total_tokens) || 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function loadCases(file) {
  const parsed = readJson(file)
  const cases = Array.isArray(parsed) ? parsed : parsed.cases
  if (!Array.isArray(cases)) throw new Error(`no "cases" array in ${file}`)
  return cases
}

const options = parseArgs(process.argv.slice(2))
const cases = loadCases(options.cases)
const responses = options.responses ? readJson(options.responses) : null
const limit = options.limit > 0 ? options.limit : cases.length
const rows = []

for (const entry of cases.slice(0, limit)) {
  const context = buildContext(entry.messages, entry.tracker || {})
  if (!context) {
    console.log(`${entry.id}: skipped (insufficient context)`)
    continue
  }
  const language = /[\u3400-\u9fff]/u.test(context.lastUser) ? 'Simplified Chinese' : 'English'
  const prompt = buildPrompt(context, language)

  if (options.dryRun) {
    console.log(`\n=== ${entry.id} ===`)
    console.log('SYSTEM\n' + prompt.system)
    console.log('\nUSER\n' + prompt.user)
    console.log('\nACTUAL\n' + entry.actual)
    continue
  }

  const started = Date.now()
  let text = ''
  let tokens = 0
  if (responses) {
    const recorded = responses[entry.id]
    text = typeof recorded === 'string' ? recorded : JSON.stringify(recorded || '')
  } else {
    const reply = await providerReply(prompt)
    text = reply.text
    tokens = reply.tokens
  }
  const elapsed = Date.now() - started
  const parsed = parseCandidates(text, 5, context.lastUser, [])
  const ranked = rankCandidates(parsed, context, 3)
  const top1 = ranked.length > 0 ? similarity(ranked[0], entry.actual) : 0
  const top3 = bestSimilarity(ranked, entry.actual)
  const entities = context.entities || []
  const grounded = ranked.filter((candidate) => entities.some((entity) => mentions(candidate, entity))).length
  rows.push({ id: entry.id, top1, top3, grounded, count: ranked.length, elapsed, tokens })
  console.log(
    `${entry.id}\ttop1=${top1.toFixed(2)}\ttop3=${top3.toFixed(2)}\tgrounded=${grounded}/${ranked.length}\tms=${elapsed}\ttok=${tokens}`,
  )
  console.log(`  candidates: ${JSON.stringify(ranked)}`)
  console.log(`  actual:     ${entry.actual.slice(0, 160)}`)
}

if (options.dryRun) {
  console.log('\nDry run only. Set EVAL_BASE_URL / EVAL_API_KEY / EVAL_MODEL to score.')
} else if (rows.length > 0) {
  const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length
  console.log(
    `\nMEAN top1=${mean('top1').toFixed(2)} top3=${mean('top3').toFixed(2)} grounded=${mean('grounded').toFixed(1)} ms=${Math.round(mean('elapsed'))} tok=${Math.round(mean('tokens'))}`,
  )
}
