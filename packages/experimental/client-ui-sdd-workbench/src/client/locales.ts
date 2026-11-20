/** Locale dictionaries for the SDD Workbench panel. */


/** Dictionary namespace shared by the sidebar entry and the global panel. */
export const NS = 'sdd-workbench'

/** Dictionary keys of the panel namespace, derived from the English copy. */
export type SddLocaleKey = 'panel' | 'title' | 'refresh' | 'back' | 'loading'
  | 'empty.title' | 'empty.hint' | 'empty.features'
  | 'error.scan' | 'error.doc' | 'error.bad-path' | 'error.not-text' | 'error.not-found'
  | 'truncated'
  | 'artifact.brief' | 'artifact.prd' | 'artifact.design' | 'artifact.review' | 'artifact.test' | 'artifact.materials'
  | 'phase.unknown' | 'section.planned' | 'section.active' | 'section.done'

/** Panel copy in English; `zh` mirrors the keys above. */
export const en: Record<SddLocaleKey, string> = {
  'panel': 'SDD Workbench',
  'title': 'SDD Workbench',
  'refresh': 'Refresh',
  'back': 'Back to list',
  'loading': 'Scanning mai-specs…',
  'empty.title': 'No mai-specs directory',
  'empty.hint': 'Run `mai init` in this workspace to start a spec-driven delivery, then refresh.',
  'empty.features': 'No features yet — mai-specs/ has no NNN-slug workspaces.',
  'error.scan': 'Failed to scan the workspace.',
  'error.doc': 'Failed to read this document.',
  'error.bad-path': 'The requested path leaves the allowed spec surface.',
  'error.not-text': 'This file is not UTF-8 text.',
  'error.not-found': 'This file no longer exists.',
  'truncated': 'Document truncated at the size limit.',
  'artifact.brief': 'Brief',
  'artifact.prd': 'PRD',
  'artifact.design': 'Design',
  'artifact.review': 'Review',
  'artifact.test': 'Test',
  'artifact.materials': 'Materials',
  'phase.unknown': '—',
  'section.planned': 'Planned',
  'section.active': 'Active',
  'section.done': 'Done',
} as const

/** Panel copy in Simplified Chinese. */
export const zh: typeof en = {
  'panel': 'SDD 工作台',
  'title': 'SDD 工作台',
  'refresh': '刷新',
  'back': '返回列表',
  'loading': '正在扫描 mai-specs…',
  'empty.title': '未找到 mai-specs 目录',
  'empty.hint': '在本工作区运行 `mai init` 开启规格驱动交付，然后点刷新。',
  'empty.features': '暂无 Feature——mai-specs/ 下没有 NNN-slug 工作区。',
  'error.scan': '扫描工作区失败。',
  'error.doc': '读取文档失败。',
  'error.bad-path': '请求路径超出允许的规格范围。',
  'error.not-text': '该文件不是 UTF-8 文本。',
  'error.not-found': '该文件已不存在。',
  'truncated': '文档超过大小上限，已截断。',
  'artifact.brief': '简报',
  'artifact.prd': 'PRD',
  'artifact.design': '技术设计',
  'artifact.review': '评审',
  'artifact.test': '测试',
  'artifact.materials': '素材',
  'phase.unknown': '—',
  'section.planned': '规划中',
  'section.active': '进行中',
  'section.done': '已完成',
} as const
