import type { BomItem, ComponentLibraryItem } from './assembly-data'
import { footprintCategoryOf } from './footprint-categories'
import libraryManifestJson from '../footprint/library-manifest.json'

export interface FootprintModel {
  name: string
  normalizedName: string
  sourcePath: string
  url: string
  stepUrl?: string
  modelCorrectionQuaternion?: readonly [number, number, number, number]
}

export interface FootprintSource {
  alias: string
  normalizedAlias: string
  category: string
  file: string
  source: string
  confidence: 'exact' | 'compatible' | 'user'
  note: string
}

export interface ComponentLibraryFootprintMatch {
  source: FootprintSource
  model: FootprintModel
  packageName: string
  forced: boolean
}

export interface FootprintModelMatcher {
  matchFootprintModel: (item: BomItem) => FootprintModel | null
  matchBomFootprintModels: (items: BomItem[]) => Map<string, FootprintModel>
  matchComponentLibraryFootprint: (
    item: Pick<ComponentLibraryItem, 'materialName'>,
  ) => ComponentLibraryFootprintMatch | null
}

interface FootprintLibraryManifest {
  entries: Array<{
    alias: string
    category: string
    file: string | null
    source: string
    confidence: 'exact' | 'compatible' | 'user' | 'manual-needed'
    status: 'copied' | 'missing' | 'manual-needed'
    note: string
  }>
}

interface FootprintCatalogEntry {
  source_path: string
  name: string
  extension: '.step' | '.stp' | '.glb'
  url: string
}

interface FootprintCatalogResponse {
  models?: unknown
  error?: string
}

const modelSuffix = /\.(?:glb|step|stp)$/i

export function normalizeFootprintName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(modelSuffix, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '')
}

function isFootprintCatalogEntry(value: unknown): value is FootprintCatalogEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.source_path === 'string'
    && typeof entry.name === 'string'
    && typeof entry.url === 'string'
    && (entry.extension === '.step' || entry.extension === '.stp' || entry.extension === '.glb')
}

/**
 * 从本机服务读取完整模型库目录。清单只包含名称、路径和按需读取地址，
 * 不会将 3D 模型内容放进 Vite 构建产物。
 */
export async function fetchFootprintModels(): Promise<FootprintModel[]> {
  const response = await fetch('/api/footprint/models')
  const payload = await response.json().catch(() => ({})) as FootprintCatalogResponse
  if (!response.ok) throw new Error(payload.error || `读取 STEP 3D 封装库失败 (${response.status})`)
  if (!Array.isArray(payload.models)) throw new Error('STEP 3D 封装库返回格式无效')

  const grouped = new Map<string, {
    name: string
    sourcePath: string
    step?: FootprintCatalogEntry
    glb?: FootprintCatalogEntry
  }>()

  payload.models.filter(isFootprintCatalogEntry).forEach((entry) => {
    const basePath = entry.source_path.replace(modelSuffix, '')
    const current = grouped.get(basePath) ?? {
      name: entry.name || (entry.source_path.split('/').pop() ?? '').replace(modelSuffix, ''),
      sourcePath: entry.source_path,
    }
    if (entry.extension === '.glb') current.glb = entry
    else if (!current.step || entry.extension === '.step') current.step = entry
    if (current.step) current.sourcePath = current.step.source_path
    else if (current.glb) current.sourcePath = current.glb.source_path
    grouped.set(basePath, current)
  })

  return [...grouped.values()]
    .map((entry) => ({
      name: entry.name,
      normalizedName: normalizeFootprintName(entry.name),
      sourcePath: entry.sourcePath,
      url: entry.glb?.url ?? '',
      stepUrl: entry.step?.url,
    }))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, 'zh-CN'))
}

/**
 * 保留空导出以兼容旧调用方。模型库现在由 `fetchFootprintModels` 从本机服务按需加载。
 */
export const footprintModels: FootprintModel[] = []

const libraryManifest = libraryManifestJson as FootprintLibraryManifest

export const footprintSources: FootprintSource[] = libraryManifest.entries.flatMap((entry) => (
  entry.status === 'copied' && entry.file && entry.confidence !== 'manual-needed'
    ? [{
        alias: entry.alias,
        normalizedAlias: normalizeFootprintName(entry.alias),
        category: entry.category,
        file: entry.file,
        source: entry.source,
        confidence: entry.confidence,
        note: entry.note,
      }]
    : []
))

const sourceByAlias = new Map(footprintSources.map((source) => [source.normalizedAlias, source]))

function componentLibraryNameParts(materialName: string): string[] {
  return materialName
    .replace(/^(?:\s*【[^】]+】)+\s*/, '')
    .split('|')
    .map((part) => part.trim())
}

const passiveFamilyLetters: Record<string, string> = { C: 'C', RES: 'R', L: 'L' }
const kicadPassiveModelNamePattern = /^(C|R|L)_(\d{3,5})_\d{3,5}Metric$/

function itemMatchCandidates(item: BomItem): string[] {
  return [item.footprint, item.partNumber, item.value]
    .map(normalizeFootprintName)
    .filter(Boolean)
}

function passiveFootprintMatch(
  parts: string[],
  passiveModelByFamilySize: ReadonlyMap<string, FootprintModel>,
): ComponentLibraryFootprintMatch | null {
  const letter = passiveFamilyLetters[parts[0]?.toLocaleUpperCase() ?? '']
  const packageName = parts[1] ?? ''
  if (!letter || !packageName) return null

  const size = normalizeFootprintName(packageName).replace(/l$/, '')
  const model = passiveModelByFamilySize.get(`${letter}|${size}`)
  if (!model) return null

  const category = footprintCategoryOf(model.sourcePath)
  return {
    source: {
      alias: packageName,
      normalizedAlias: size,
      category: category.folder,
      file: model.sourcePath.replace(/^\/footprint\//, ''),
      source: model.name,
      confidence: 'exact',
      note: `${parts[0].toLocaleUpperCase()} ${size} 英制封装 → ${model.name}`,
    },
    model,
    packageName,
    forced: true,
  }
}

/**
 * 为一次模型目录加载创建匹配索引。App 会把这个对象缓存下来，
 * 避免对每一条金蝶物料重复遍历数千个 STEP 模型。
 */
export function createFootprintModelMatcher(models: FootprintModel[]): FootprintModelMatcher {
  const modelsInPathOrder = [...models].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, 'zh-CN'))
  const modelByName = new Map<string, FootprintModel>()
  const passiveModelByFamilySize = new Map<string, FootprintModel>()

  modelsInPathOrder.forEach((model) => {
    if (!modelByName.has(model.normalizedName)) modelByName.set(model.normalizedName, model)
    const matched = kicadPassiveModelNamePattern.exec(model.name)
    if (!matched) return
    const key = `${matched[1]}|${matched[2]}`
    if (!passiveModelByFamilySize.has(key)) passiveModelByFamilySize.set(key, model)
  })

  const sourceModelPairs = footprintSources.flatMap((source) => {
    const sourceFileName = source.file.split(/[\\/]/).pop() ?? source.file
    const model = modelByName.get(normalizeFootprintName(sourceFileName))
    return model ? [{ source, model }] : []
  })

  const matchItem = (item: BomItem): FootprintModel | null => {
    for (const candidate of itemMatchCandidates(item)) {
      const model = modelByName.get(candidate)
      if (model) return model
    }
    return null
  }

  return {
    matchFootprintModel: matchItem,
    matchBomFootprintModels: (items) => {
      const matches = new Map<string, FootprintModel>()
      items.forEach((item) => {
        const model = matchItem(item)
        if (model) matches.set(item.id, model)
      })
      return matches
    },
    matchComponentLibraryFootprint: (item) => {
      const parts = componentLibraryNameParts(item.materialName)
      const passiveMatch = passiveFootprintMatch(parts, passiveModelByFamilySize)
      if (passiveMatch) return passiveMatch

      const normalizedParts = parts.map(normalizeFootprintName).filter(Boolean)
      const normalizedFullName = normalizeFootprintName(parts.join('|'))
      const pair = [...sourceModelPairs]
        .sort((left, right) => right.source.normalizedAlias.length - left.source.normalizedAlias.length)
        .find(({ source }) => (
          normalizedParts.includes(source.normalizedAlias)
          || (source.normalizedAlias.length >= 6 && normalizedFullName.includes(source.normalizedAlias))
        ))

      return pair
        ? {
            ...pair,
            packageName: parts.find((part) => normalizeFootprintName(part) === pair.source.normalizedAlias)
              ?? pair.source.alias,
            forced: false,
          }
        : null
    },
  }
}

export function matchFootprintModel(item: BomItem, models: FootprintModel[] = footprintModels): FootprintModel | null {
  return createFootprintModelMatcher(models).matchFootprintModel(item)
}

export function matchBomFootprintModels(
  items: BomItem[],
  models: FootprintModel[] = footprintModels,
): Map<string, FootprintModel> {
  return createFootprintModelMatcher(models).matchBomFootprintModels(items)
}

export function matchBomFootprintSources(items: BomItem[]): Map<string, FootprintSource> {
  const matches = new Map<string, FootprintSource>()
  items.forEach((item) => {
    for (const candidate of itemMatchCandidates(item)) {
      const source = sourceByAlias.get(candidate)
      if (source) {
        matches.set(item.id, source)
        break
      }
    }
  })
  return matches
}

export function matchComponentLibraryFootprint(
  item: Pick<ComponentLibraryItem, 'materialName'>,
  models: FootprintModel[] = footprintModels,
): ComponentLibraryFootprintMatch | null {
  return createFootprintModelMatcher(models).matchComponentLibraryFootprint(item)
}
