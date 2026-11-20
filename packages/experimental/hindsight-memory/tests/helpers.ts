/**
 * Shared test helpers: fake Response/fetch, lossless-JSON assertions ported
 * from the baseline integration suite, and fixture builders.
 *
 * @module tests/helpers
 */

import { expect } from 'vitest'

/** One recorded fetch call. */
export interface FetchCall {
  url: string
  init: RequestInit
}

/** Minimal JSON Response stand-in accepted by the client's `response.text()/ok/status`. */
export function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, {
    status: init.status ?? (init.ok === false ? 500 : 200),
    headers: { 'content-type': 'application/json' },
  })
}

/** A fetch stub that answers per-path handlers and records every call. */
export function createFetchStub(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const effective = init ?? {}
    calls.push({ url, init: effective })
    return await handler(url, effective)
  })
  return { fetchImpl, calls }
}

/** First text block of a rendered tool result, as a plain string for assertions. */
export function renderText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks[0]?.text ?? ''
}

/** Parse one recorded request body; the client always sends JSON strings. */
export function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  const text = typeof body === 'string' ? body : '{}'
  return JSON.parse(text) as Record<string, unknown>
}

/** Recursively find the first undefined-valued field path in a tool result. */
export function findUndefined(value: unknown, path = ''): string | null {
  if (value === undefined) return path || '(root)'
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUndefined(value[index], `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = findUndefined((value as Record<string, unknown>)[key], `${path}.${key}`)
      if (found) return found
    }
  }
  return null
}

/** Assert a value survives lossless JSON round-tripping (baseline regression guard). */
export function assertLossless(value: unknown, label: string): void {
  expect(findUndefined(value), `${label} 含 undefined 字段`).toBeNull()
  expect(JSON.parse(JSON.stringify(value)), `${label} 无法无损 JSON 往返`).toEqual(value)
}

/** Build one MemoryEntry fixture. */
export function entry(id: string, content: string, createdAt = '2026-01-01T00:00:00.000Z') {
  return { id, content, chars: content.length, createdAt }
}
