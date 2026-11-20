/**
 * Memory content safety screening. Curated entries reach every future
 * session's model context, so writes are screened for credentials and
 * prompt-injection instructions before they persist.
 *
 * @module @deepseek-ai/dsh-hindsight-memory/security
 */

import type { InspectLengthResult, InspectResult } from './types.ts'

/** Common credential forms. Over-blocking is preferred over leaking a secret into long-term memory. */
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|私钥|密码|口令)\s*[:=：]\s*\S{6,}/i,
])

/** Prompt-injection / jailbreak instructions. */
const INJECTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions/i,
  /disregard\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|rules)/i,
  /忽略(?:以上|之前|前面)?(?:的)?(?:所有)?(?:指令|提示|规则|要求)/,
  /你现在是(?:一个)?(?:没有|无)限制/,
  /system\s*[:：]\s*you\s+are/i,
  /<\|im_start\|>|<\|im_end\|>/,
])

/**
 * Screen one memory write for secrets and injection text.
 * @param text - trimmed-or-not candidate content.
 * @param options - `protectSecrets: false` opens the credential screen only; the injection screen always runs.
 * @returns `{ ok: true }`, or the first failure kind with its user-facing reason.
 */
export function inspectContent(text: string, options: { protectSecrets?: boolean } = {}): InspectResult {
  const content = text.trim()
  if (content.length === 0) return { ok: false, kind: 'empty', reason: '内容为空。' }

  if (options.protectSecrets !== false) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(content)) {
        return {
          ok: false,
          kind: 'secret',
          reason: '内容疑似包含密钥/口令。长期记忆不保存凭据，请改写为「凭据放在哪里」而不是「凭据是什么」。',
        }
      }
    }
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return {
        ok: false,
        kind: 'injection',
        reason: '内容包含类似提示注入的指令。记忆只保存事实与偏好，不保存对模型下命令的文本。',
      }
    }
  }

  return { ok: true }
}

/**
 * Check one memory entry against its char cap.
 * @param text - candidate content.
 * @param maxChars - inclusive char limit.
 * @returns `{ ok: true }`, or `too_long` with the limit and a rewrite hint.
 */
export function inspectLength(text: string, maxChars: number): InspectLengthResult {
  const length = text.trim().length
  if (length > maxChars) {
    return {
      ok: false,
      kind: 'too_long',
      reason: `单条记忆 ${length} 字符，超过上限 ${maxChars}。请拆成多条，或压缩后重写。`,
      limit: maxChars,
    }
  }
  return { ok: true }
}
