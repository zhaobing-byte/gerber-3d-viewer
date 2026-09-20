const API_ROOT = '/api/footprint'

export interface FootprintImportResult {
  kind: 'model'
  category: string
  filename: string
  /** 稳定的模型库根相对路径，可直接写入模型绑定。 */
  source_path: string
  bytes: number
  overwritten: boolean
  /** 兼容旧接口字段；动态模型目录始终返回 `false`。 */
  requires_restart: boolean
}

/** 压缩包导入报告里单个分类的落盘数量。 */
export interface FootprintArchiveCategory {
  category: string
  count: number
}

/** 压缩包导入报告里单条模型的落盘信息，后端只回传前若干条明细。 */
export interface FootprintArchiveModel {
  category: string
  filename: string
  source_path: string
  bytes: number
  overwritten: boolean
  /** 该模型写入了本次导入新建的分类目录。 */
  created_category: boolean
}

export interface FootprintArchiveSkip {
  entry: string
  reason: string
}

export interface FootprintArchiveResult {
  kind: 'archive'
  archive: string
  /** 包内未命中库内分类的模型会落到这个分类；无默认分类（自动归位档位）时为 `null`。 */
  default_category: string | null
  written: number
  overwritten: number
  /** 包内多个条目拍平后指向同一落盘路径的次数。 */
  duplicate_names: number
  skipped_count: number
  skipped: FootprintArchiveSkip[]
  /** 本次导入新建的分类目录（未登记到 `footprint-categories.ts` 时会落到「其他」大类）。 */
  created_categories: string[]
  categories: FootprintArchiveCategory[]
  models: FootprintArchiveModel[]
  elapsed_ms: number
  /** 兼容旧接口字段；动态模型目录始终返回 `false`。 */
  requires_restart: boolean
}

/**
 * 库为空（一个分类目录都没有）时的压缩包归档档位：不指定默认分类，
 * 完全按包内 `<分类>.3dshapes/` 归位。
 * 与后端 `AUTO_CATEGORY_KEY` 必须保持一致，改动要同步。
 */
export const footprintAutoCategory = '__auto__'

/** 与后端 `MAX_IMPORT_BYTES` 保持一致，用于上传前拦截。 */
export const maxFootprintImportBytes = 80 * 1024 * 1024

/** 与后端 `MAX_PACKAGE_BYTES` 保持一致，压缩包按整包计上限。 */
export const maxFootprintArchiveBytes = 2 * 1024 * 1024 * 1024

export const footprintModelAccept = '.step,.stp,.glb,.zip'

const supportedSuffixes = ['.step', '.stp', '.glb']
const archiveSuffixes = ['.zip']

function hasSuffix(name: string, suffixes: string[]): boolean {
  const lowered = name.toLocaleLowerCase()
  return suffixes.some((suffix) => lowered.endsWith(suffix))
}

export function isSupportedFootprintFile(file: File): boolean {
  return hasSuffix(file.name, supportedSuffixes)
}

/** 是否为受支持的压缩包（当前仅 .zip，与后端 `ALLOWED_PACKAGE_SUFFIXES` 一致）。 */
export function isFootprintArchive(file: File): boolean {
  return hasSuffix(file.name, archiveSuffixes)
}

export function isSupportedFootprintUpload(file: File): boolean {
  return isSupportedFootprintFile(file) || isFootprintArchive(file)
}

/** 该文件适用的上传体积上限。 */
export function footprintUploadLimit(file: File): number {
  return isFootprintArchive(file) ? maxFootprintArchiveBytes : maxFootprintImportBytes
}

async function postFootprintUpload<T>(category: string, file: File): Promise<T> {
  const query = new URLSearchParams({ category, filename: file.name })
  const response = await fetch(`${API_ROOT}/import?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) {
    throw new Error(payload.error || `模型导入失败 (${response.status})`)
  }
  return payload as T
}

/** 上传单个模型文件到本机服务的指定分类目录。 */
export async function importFootprintModel(category: string, file: File): Promise<FootprintImportResult> {
  return postFootprintUpload<FootprintImportResult>(category, file)
}

/**
 * 上传 ZIP 压缩包，由本机服务解压归位。
 *
 * 包内最近的 `<分类>.3dshapes/` 目录决定模型去向：已有分类直接归位，库内没有的分类
 * 自动新建；深层子目录会被拍平，非模型条目会被跳过并在报告中列出。
 * 包内没有该层级时（含散装文件）落入 `category`。
 */
export async function importFootprintArchive(
  category: string,
  file: File,
): Promise<FootprintArchiveResult> {
  const payload = await postFootprintUpload<Partial<FootprintArchiveResult>>(category, file)
  return {
    kind: 'archive',
    archive: payload.archive ?? file.name,
    default_category: payload.default_category ?? null,
    written: payload.written ?? 0,
    overwritten: payload.overwritten ?? 0,
    duplicate_names: payload.duplicate_names ?? 0,
    skipped_count: payload.skipped_count ?? 0,
    skipped: payload.skipped ?? [],
    created_categories: payload.created_categories ?? [],
    categories: payload.categories ?? [],
    models: payload.models ?? [],
    elapsed_ms: payload.elapsed_ms ?? 0,
    requires_restart: payload.requires_restart ?? false,
  }
}
