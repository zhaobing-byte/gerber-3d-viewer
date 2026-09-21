import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownFromLine,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  ArrowUpToLine,
  CheckCircle2,
  CloudDownload,
  Cuboid,
  Database,
  Download,
  FileArchive,
  FileSpreadsheet,
  FlipVertical2,
  FolderOpen,
  Info,
  Layers3,
  LoaderCircle,
  MapPin,
  RefreshCw,
  RotateCw,
  Search,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react'
import PcbViewer, {
  type CameraPreset,
  type LayerVisibility,
  type PackageOrientation,
} from './PcbViewer'
import BomItemReplacePicker from './BomItemReplacePicker'
import FootprintModelBrowser from './FootprintModelBrowser'
import KingdeeConnectionPanel from './KingdeeConnectionPanel'
import StepModelPicker from './StepModelPicker'
import {
  materialMatchesFileName,
  materialMatchesStore,
  modelBindingsFileName,
  modelBindingsStore,
  syncStringMapStore,
  type StringMap,
} from './binding-store'
import {
  parseBomFile,
  parsePlacementFile,
  type BomItem,
  type ComponentLibraryItem,
  type ParsedBomFile,
  type ParsedComponentLibraryFile,
  type ParsedPlacementFile,
} from './assembly-data'
import {
  layerNames,
  parseBoard,
  readSourceFiles,
  selectBoardProfile,
  type ParsedBoard,
  type SourceFile,
} from './gerber'
import {
  createFootprintModelMatcher,
  fetchFootprintModels,
  type FootprintModel,
} from './footprint-library'
import {
  matchBomItemToLibrary,
  matchBomItemsToLibrary,
  normalizeText,
  scoreBomLibraryCandidate,
  type BomLibraryMatch,
} from './component-library-matching'
import { alignPlacements } from './placement-alignment'
import { syncKingdeeComponentLibrary } from './kingdee-api'

const colorOptions = [
  { name: '绿色阻焊', value: '#11734a' },
  { name: '蓝色阻焊', value: '#2f78a8' },
  { name: '红色阻焊', value: '#b64040' },
  { name: '黑色阻焊', value: '#303531' },
]

const visibilityLabels: Array<{ key: keyof LayerVisibility; label: string; color: string }> = [
  { key: 'board', label: '基材', color: '#d8ad4f' },
  { key: 'copper', label: '铜层', color: '#d0a84f' },
  { key: 'mask', label: '阻焊', color: '#1b9b68' },
  { key: 'silkscreen', label: '丝印', color: '#eeeae0' },
  { key: 'drill', label: '钻孔', color: '#080b09' },
  { key: 'components', label: '元件位置', color: '#7e8b85' },
  { key: 'grid', label: '网格', color: '#58685e' },
]

type BomColumnKey = 'check' | 'sku' | 'name' | 'spec' | 'description' | 'designator'
  | 'quantity' | 'footprint' | 'actions'

type BomColumnDefinition = {
  key: BomColumnKey
  label: string
  className: string
  headerClassName?: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
}

type LibraryColumnKey = 'sku' | 'name' | 'dataStatus' | 'disabledStatus' | 'unit' | 'model'

type LibraryColumnDefinition = {
  key: LibraryColumnKey
  label: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
}

type BomCellEdit = {
  itemId: string
  field: 'materialName' | 'spec'
  value: string
}

type PendingBomItem = {
  item: BomItem
  index: number
}

/** 「替换元件」的发起方：待处理行（未核对）或核对行（已核对）。 */
type BomReplaceRequest = {
  id: string
  source: 'pending' | 'checked'
}

type MaterialModelBindings = Record<string, string>

const materialModelBindingsStorageKey = 'fabview.kingdee-step-bindings.v1'
const materialMatchesStorageKey = 'fabview.kingdee-material-matches.v1'

/** 位置微调每次的步长（mm），六个移动按钮共用。 */
const bomRowNudgeStepMm = 0.25

function emptyPackageOrientation(): PackageOrientation {
  return { rotationZ: 0, rotationX: 0, offsetX: 0, offsetY: 0, offsetZ: 0 }
}

interface BomNudgeControl {
  axis: 'offsetX' | 'offsetY' | 'offsetZ'
  direction: 1 | -1
  label: string
  hint: string
  Icon: typeof ArrowLeft
}

const bomRowNudgeControls: readonly BomNudgeControl[] = [
  { axis: 'offsetX', direction: -1, label: '左移动', hint: '沿板面 X 轴左移', Icon: ArrowLeft },
  { axis: 'offsetX', direction: 1, label: '右移动', hint: '沿板面 X 轴右移', Icon: ArrowRight },
  { axis: 'offsetY', direction: 1, label: '上移动', hint: '沿板面 Y 轴上移', Icon: ArrowUp },
  { axis: 'offsetY', direction: -1, label: '下移动', hint: '沿板面 Y 轴下移', Icon: ArrowDown },
  { axis: 'offsetZ', direction: 1, label: '高度+', hint: '沿元件面法向抬高', Icon: ArrowUpFromLine },
  { axis: 'offsetZ', direction: -1, label: '高度-', hint: '沿元件面法向降低', Icon: ArrowDownFromLine },
]
const bomTableColumns: BomColumnDefinition[] = [
  { key: 'check', label: '确认状态', className: 'bom-col-check', headerClassName: 'bom-check-cell', defaultWidth: 36, minWidth: 32, maxWidth: 72 },
  { key: 'sku', label: '编码', className: 'bom-col-sku', defaultWidth: 82, minWidth: 56, maxWidth: 420 },
  { key: 'name', label: '物料名称', className: 'bom-col-name', defaultWidth: 110, minWidth: 72, maxWidth: 520 },
  { key: 'spec', label: '规格', className: 'bom-col-spec', defaultWidth: 120, minWidth: 72, maxWidth: 520 },
  { key: 'description', label: '名称', className: 'bom-col-description', defaultWidth: 140, minWidth: 72, maxWidth: 640 },
  { key: 'footprint', label: '封装', className: 'bom-col-footprint', defaultWidth: 90, minWidth: 64, maxWidth: 420 },
  { key: 'designator', label: '位号', className: 'bom-col-designator', defaultWidth: 88, minWidth: 60, maxWidth: 420 },
  { key: 'quantity', label: '数量', className: 'bom-col-quantity', defaultWidth: 40, minWidth: 40, maxWidth: 120 },
  { key: 'actions', label: '操作', className: 'bom-col-actions', headerClassName: 'bom-actions-heading', defaultWidth: 154, minWidth: 140, maxWidth: 260 },
]

const productionBomExportHeaders = ['序号', '编码', '物料名称', '规格', '名称', '封装', '位号', '用量', '数量', '备注']

const productionBomThinBorder = {
  top: { style: 'thin', color: { rgb: 'FF000000' } },
  right: { style: 'thin', color: { rgb: 'FF000000' } },
  bottom: { style: 'thin', color: { rgb: 'FF000000' } },
  left: { style: 'thin', color: { rgb: 'FF000000' } },
}

const productionBomInfoStyle = {
  font: { name: '宋体', sz: 9, color: { rgb: 'FF000000' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: productionBomThinBorder,
}

const productionBomHeaderStyle = {
  ...productionBomInfoStyle,
  fill: { patternType: 'solid', fgColor: { rgb: 'FFC0C0C0' } },
}

const productionBomDataStyle = {
  font: { name: '等线', sz: 12, color: { rgb: 'FF000000' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: productionBomThinBorder,
}

const productionBomNumberStyle = {
  ...productionBomDataStyle,
  numFmt: '0',
}

type ProductionBomSavePickerOptions = {
  suggestedName: string
  types: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}

type ProductionBomSaveFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>
    close: () => Promise<void>
  }>
}

type ProductionBomSaveWindow = Window & {
  showSaveFilePicker?: (
    options: ProductionBomSavePickerOptions,
  ) => Promise<ProductionBomSaveFileHandle>
}

function defaultBomColumnWidths(): Record<BomColumnKey, number> {
  return Object.fromEntries(
    bomTableColumns.map((column) => [column.key, column.defaultWidth]),
  ) as Record<BomColumnKey, number>
}

const libraryTableColumns: LibraryColumnDefinition[] = [
  { key: 'sku', label: '编码', defaultWidth: 150, minWidth: 88, maxWidth: 420 },
  { key: 'name', label: '名称', defaultWidth: 480, minWidth: 180, maxWidth: 820 },
  { key: 'dataStatus', label: '数据状态', defaultWidth: 150, minWidth: 84, maxWidth: 320 },
  { key: 'disabledStatus', label: '禁用状态', defaultWidth: 150, minWidth: 84, maxWidth: 320 },
  { key: 'unit', label: '单位', defaultWidth: 110, minWidth: 64, maxWidth: 220 },
  { key: 'model', label: '3D封装', defaultWidth: 220, minWidth: 210, maxWidth: 320 },
]

function defaultLibraryColumnWidths(): Record<LibraryColumnKey, number> {
  return Object.fromEntries(
    libraryTableColumns.map((column) => [column.key, column.defaultWidth]),
  ) as Record<LibraryColumnKey, number>
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function productionBomFileName(file: File | null): string {
  const sourceName = file?.name.replace(/\.[^.]+$/, '') ?? ''
  const safeName = sourceName.replace(/[\\/:*?"<>|]+/g, '_').trim()
  return `${safeName || '生产BOM'}-生产BOM.xlsx`
}

function requestProductionBomSaveHandle(fileName: string): Promise<ProductionBomSaveFileHandle> | null {
  const picker = (window as ProductionBomSaveWindow).showSaveFilePicker
  if (!picker) return null
  return picker.call(window, {
    suggestedName: fileName,
    types: [
      {
        description: 'Excel 工作簿',
        accept: {
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
        },
      },
    ],
  })
}

function isSavePickerCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function shortDesignators(designators: string[]): string {
  if (designators.length === 0) return '—'
  if (designators.length <= 3) return designators.join(', ')
  return `${designators.slice(0, 2).join(', ')} +${designators.length - 2}`
}

function bomPrimaryText(item: BomItem): string {
  return item.partNumber || item.value || item.materialName || item.description || '未命名物料'
}

function componentLibraryDisplayName(materialName: string): string {
  return materialName.replaceAll('【停售】', '').trim()
}

function componentLibraryField(materialName: string): string {
  const displayName = componentLibraryDisplayName(materialName)
  const separatorIndex = displayName.indexOf('|')
  if (separatorIndex < 0) return '未分类'
  return displayName.slice(0, separatorIndex).trim() || '未分类'
}

function enrichBomItemFromLibrary(item: BomItem, libraryItem: ComponentLibraryItem): BomItem {
  return {
    ...item,
    sku: libraryItem.sku,
    description: componentLibraryDisplayName(libraryItem.materialName),
  }
}

function materialModelBindingKey(item: ComponentLibraryItem): string {
  return item.sku.trim() ? `sku:${item.sku.trim()}` : `id:${item.id}`
}

/**
 * 人工「替换元件」结果的持久化键。取 BOM 行的「描述」（金蝶导出的 BOM 这一列就是
 * 物料名，重新导入同一份 BOM 时不变）→ 归一化；没有描述时退到物料名称。
 */
function materialMatchKey(item: BomItem): string {
  const source = normalizeText(item.description || item.materialName)
  return source ? `mat:${source}` : ''
}

/** 重新导入 BOM 时回放人工核对决定；物料在 ERP 里已不存在则作废（不报错）。 */
function recallSavedMatch(
  item: BomItem,
  library: ParsedComponentLibraryFile | null,
  savedMatches: StringMap,
): BomLibraryMatch | null {
  const key = materialMatchKey(item)
  const sku = key ? savedMatches[key] : undefined
  if (!sku) return null
  const libraryItem = (library?.items ?? []).find((candidate) => candidate.sku === sku)
  return libraryItem ? { libraryItem, score: scoreBomLibraryCandidate(item, libraryItem) } : null
}

function loadStringMap(storageKey: string): StringMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

/** localStorage 现在只是本地缓存 + 服务端不可用时的兜底，工程文件才是准。 */
function saveStringMap(storageKey: string, entries: StringMap) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(entries))
  } catch {
    // 浏览器存储不可用时，内存里的绑定依然生效。
  }
}

function App() {
  const gerberInputRef = useRef<HTMLInputElement>(null)
  const bomInputRef = useRef<HTMLInputElement>(null)
  const bomTableWrapRef = useRef<HTMLDivElement | null>(null)
  const placementInputRef = useRef<HTMLInputElement>(null)
  const [board, setBoard] = useState<ParsedBoard | null>(null)
  const [gerberImportName, setGerberImportName] = useState('')
  const [bomFile, setBomFile] = useState<File | null>(null)
  const [placementFile, setPlacementFile] = useState<File | null>(null)
  const [bomData, setBomData] = useState<ParsedBomFile | null>(null)
  const [sourceBomData, setSourceBomData] = useState<ParsedBomFile | null>(null)
  const [bomLibraryMatches, setBomLibraryMatches] = useState<Map<string, BomLibraryMatch>>(
    () => new Map(),
  )
  const [placementData, setPlacementData] = useState<ParsedPlacementFile | null>(null)
  const [componentLibraryData, setComponentLibraryData] = useState<ParsedComponentLibraryFile | null>(null)
  const [componentLibraryPageOpen, setComponentLibraryPageOpen] = useState(true)
  const [componentLibraryPageView, setComponentLibraryPageView] = useState<'connection' | 'materials'>('connection')
  const [kingdeeDatabaseConnected, setKingdeeDatabaseConnected] = useState(false)
  const [kingdeeSyncing, setKingdeeSyncing] = useState(false)
  const [kingdeeLastSync, setKingdeeLastSync] = useState<Date | null>(null)
  const [componentLibraryQuery, setComponentLibraryQuery] = useState('')
  const [componentLibraryFieldFilter, setComponentLibraryFieldFilter] = useState<string | null>(null)
  const [footprintModels, setFootprintModels] = useState<FootprintModel[]>([])
  const [footprintModelsLoading, setFootprintModelsLoading] = useState(true)
  const [footprintModelsError, setFootprintModelsError] = useState<string | null>(null)
  const [materialModelBindings, setMaterialModelBindings] = useState<MaterialModelBindings>(
    () => loadStringMap(materialModelBindingsStorageKey),
  )
  const [materialMatches, setMaterialMatches] = useState<StringMap>(
    () => loadStringMap(materialMatchesStorageKey),
  )
  const [manualModelTargetId, setManualModelTargetId] = useState<string | null>(null)
  const [selectedLibraryItemId, setSelectedLibraryItemId] = useState<string | null>(null)
  const [selectedLibraryModelPath, setSelectedLibraryModelPath] = useState<string | null | undefined>(undefined)
  const [bomQuery, setBomQuery] = useState('')
  const [confirmedBomIds, setConfirmedBomIds] = useState<Set<string>>(() => new Set())
  const [selectedBomId, setSelectedBomId] = useState<string | null>(null)
  const [bomRowOrientations, setBomRowOrientations] = useState<Map<string, PackageOrientation>>(
    () => new Map(),
  )
  const [bomSelectionRevision, setBomSelectionRevision] = useState(0)
  const [bomCellEdit, setBomCellEdit] = useState<BomCellEdit | null>(null)
  const [pendingBomItems, setPendingBomItems] = useState<PendingBomItem[]>([])
  const [bomReplaceRequest, setBomReplaceRequest] = useState<BomReplaceRequest | null>(null)
  const [bomColumnWidths, setBomColumnWidths] = useState(defaultBomColumnWidths)
  const [resizingBomColumn, setResizingBomColumn] = useState<BomColumnKey | null>(null)
  const bomColumnDragRef = useRef<{
    key: BomColumnKey
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)
  const [libraryColumnWidths, setLibraryColumnWidths] = useState(defaultLibraryColumnWidths)
  const [resizingLibraryColumn, setResizingLibraryColumn] = useState<LibraryColumnKey | null>(null)
  const libraryColumnDragRef = useRef<{
    key: LibraryColumnKey
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)
  const [auxiliaryLoading, setAuxiliaryLoading] = useState<'bom' | 'placement' | null>(null)
  const [exportingProductionBom, setExportingProductionBom] = useState(false)
  const [loading, setLoading] = useState({ active: false, progress: 0, file: '' })
  const [error, setError] = useState<string | null>(null)
  const [draggingImport, setDraggingImport] = useState<'gerber' | 'bom' | 'placement' | null>(null)
  const [thickness, setThickness] = useState(1.6)
  const [boardColor, setBoardColor] = useState(colorOptions[0].value)
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('iso')
  const [cameraRevision, setCameraRevision] = useState(0)
  const [visibility, setVisibility] = useState<LayerVisibility>({
    board: true,
    copper: true,
    mask: true,
    silkscreen: true,
    drill: true,
    components: true,
    grid: true,
  })
  const selectedBomItem = useMemo(
    () => bomData?.items.find((item) => item.id === selectedBomId) ?? null,
    [bomData, selectedBomId],
  )

  const adjustSelectedBomRowOrientation = (axis: keyof PackageOrientation) => {
    if (!selectedBomItem) return
    setBomRowOrientations((current) => {
      const next = new Map(current)
      const orientation = next.get(selectedBomItem.id) ?? emptyPackageOrientation()
      next.set(selectedBomItem.id, {
        ...orientation,
        [axis]: (orientation[axis] + 90) % 360,
      })
      return next
    })
  }

  /** 位置微调：位移是相对原始坐标的绝对量，反复点不会累积漂移。 */
  const nudgeSelectedBomRow = (
    axis: BomNudgeControl['axis'],
    direction: BomNudgeControl['direction'],
  ) => {
    if (!selectedBomItem) return
    setBomRowOrientations((current) => {
      const next = new Map(current)
      const orientation = next.get(selectedBomItem.id) ?? emptyPackageOrientation()
      const value = Math.round((orientation[axis] + direction * bomRowNudgeStepMm) * 1000) / 1000
      next.set(selectedBomItem.id, { ...orientation, [axis]: value })
      return next
    })
  }

  const resetLibraryModelSelection = () => {
    setManualModelTargetId(null)
    setSelectedLibraryItemId(null)
    setSelectedLibraryModelPath(undefined)
  }

  const refreshFootprintModels = async () => {
    setFootprintModelsLoading(true)
    try {
      const models = await fetchFootprintModels()
      setFootprintModels(models)
      setFootprintModelsError(null)
    } catch (catalogError) {
      setFootprintModels([])
      setFootprintModelsError(
        catalogError instanceof Error ? catalogError.message : '无法读取本机 STEP 3D 封装库',
      )
      throw catalogError
    } finally {
      setFootprintModelsLoading(false)
    }
  }

  const loadSources = async (sources: SourceFile[]) => {
    setLoading({ active: true, progress: 0, file: sources[0]?.name ?? '' })
    setError(null)
    try {
      const result = await parseBoard(sources, (progress, file) => {
        setLoading({ active: true, progress, file })
      })
      setBoard(result)
      setSelectedBomId(null)
      setBomRowOrientations(new Map())
      setCameraPreset('iso')
      setCameraRevision((revision) => revision + 1)
      return true
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '文件处理失败')
      return false
    } finally {
      setLoading((current) => ({ ...current, active: false }))
    }
  }

  useEffect(() => {
    void refreshFootprintModels().catch(() => undefined)
  }, [])

  useEffect(() => {
    // 绑定记录以工程文件（footprint/*.json）为准；服务端不可用时回落到本机缓存，
    // 并在首次连通时把本机已有记录迁移上去。
    let cancelled = false
    void (async () => {
      const [bindings, matches] = await Promise.all([
        syncStringMapStore(modelBindingsStore, loadStringMap(materialModelBindingsStorageKey)),
        syncStringMapStore(materialMatchesStore, loadStringMap(materialMatchesStorageKey)),
      ])
      if (cancelled) return
      setMaterialModelBindings(bindings.entries)
      setMaterialMatches(matches.entries)
      if (bindings.source !== 'local') saveStringMap(materialModelBindingsStorageKey, bindings.entries)
      if (matches.source !== 'local') saveStringMap(materialMatchesStorageKey, matches.entries)
      const unsynced = [
        bindings.source === 'local' && Object.keys(bindings.entries).length > 0 ? modelBindingsFileName : '',
        matches.source === 'local' && Object.keys(matches.entries).length > 0 ? materialMatchesFileName : '',
      ].filter(Boolean)
      if (unsynced.length > 0) {
        setError(`未连接到本地服务，绑定记录暂时只在本机浏览器里，未能写入 ${unsynced.join('、')}（请确认 npm run api 正在运行）`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!componentLibraryPageOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (manualModelTargetId) {
        setManualModelTargetId(null)
      } else if (kingdeeDatabaseConnected && componentLibraryData) {
        setComponentLibraryPageOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [componentLibraryData, componentLibraryPageOpen, kingdeeDatabaseConnected, manualModelTargetId])

  useEffect(() => {
    if (!selectedBomItem || componentLibraryPageOpen) return
    const rotateSelectedComponent = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target
      if (target instanceof Element && target.closest('button, input, select, textarea, a, [contenteditable="true"]')) {
        return
      }
      if (target instanceof HTMLElement && target !== document.body && !target.closest('.viewer-host')) return

      event.preventDefault()
      adjustSelectedBomRowOrientation('rotationZ')
    }
    window.addEventListener('keydown', rotateSelectedComponent)
    return () => window.removeEventListener('keydown', rotateSelectedComponent)
  }, [componentLibraryPageOpen, selectedBomItem])

  useEffect(() => {
    if (!selectedBomId) return
    const frame = requestAnimationFrame(() => {
      const wrap = bomTableWrapRef.current
      const row = wrap?.querySelector<HTMLTableRowElement>('tbody tr[aria-selected="true"]')
      if (!row || !wrap) return
      const headerHeight = wrap.querySelector('thead')?.offsetHeight ?? 0
      const rowTop = row.offsetTop
      const rowBottom = rowTop + row.offsetHeight
      const visibleTop = wrap.scrollTop + headerHeight
      const visibleBottom = wrap.scrollTop + wrap.clientHeight
      if (rowTop < visibleTop) wrap.scrollTop = Math.max(0, rowTop - headerHeight)
      else if (rowBottom > visibleBottom) wrap.scrollTop = rowBottom - wrap.clientHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedBomId, bomQuery, bomSelectionRevision])

  const reconcileBomWithLibrary = (
    source: ParsedBomFile,
    library: ParsedComponentLibraryFile | null,
  ) => {
    const matches = matchBomItemsToLibrary(source.items, library?.items ?? [])
    const matchedItems: BomItem[] = []
    const unmatchedItems: PendingBomItem[] = []
    source.items.forEach((item, index) => {
      // 自动核对不出来的，回放人工「替换元件」的历史决定。
      const match = matches.get(item.id) ?? recallSavedMatch(item, library, materialMatches)
      if (match) {
        matches.set(item.id, match)
        matchedItems.push(enrichBomItemFromLibrary(item, match.libraryItem))
      } else unmatchedItems.push({ item, index })
    })
    setBomData({ ...source, items: matchedItems })
    setPendingBomItems(unmatchedItems)
    setBomLibraryMatches(matches)
    setBomQuery('')
    setConfirmedBomIds(new Set())
    setSelectedBomId(null)
    setBomCellEdit(null)
  }

  const syncComponentLibraryFromKingdee = async () => {
    setKingdeeSyncing(true)
    setError(null)
    try {
      const parsed = await syncKingdeeComponentLibrary()
      resetLibraryModelSelection()
      setComponentLibraryData(parsed)
      setComponentLibraryQuery('')
      setComponentLibraryFieldFilter(null)
      setKingdeeLastSync(new Date())
      if (sourceBomData) reconcileBomWithLibrary(sourceBomData, parsed)
      return parsed
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : '无法从金蝶同步物料数据'
      setError(`金蝶同步失败：${message}`)
      throw syncError
    } finally {
      setKingdeeSyncing(false)
    }
  }

  const handleGerberFiles = async (files: File[]) => {
    if (files.length === 0) return
    setLoading({ active: true, progress: 0, file: '读取文件' })
    setError(null)
    try {
      const sources = await readSourceFiles(files)
      const loaded = await loadSources(sources)
      if (loaded) {
        setGerberImportName(files.length === 1 ? files[0].name : `${files.length} 个文件`)
      }
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : '无法读取所选文件')
      setLoading((current) => ({ ...current, active: false }))
    }
  }

  const handleAuxiliaryFile = async (kind: 'bom' | 'placement', file?: File) => {
    if (!file) return
    const allowed = kind === 'bom'
      ? /\.(?:xlsx?|csv|tsv)$/i
      : /\.(?:xlsx?|csv|tsv|txt|pos)$/i
    if (!allowed.test(file.name)) {
      setError(kind === 'bom'
        ? 'BOM 仅支持 XLSX、XLS、CSV 或 TSV 文件'
        : '坐标文件仅支持 XLSX、XLS、CSV、TSV、TXT 或 POS 文件')
      return
    }
    if (file.size > 24 * 1024 * 1024) {
      setError(`${file.name} 超过 24 MB 限制`)
      return
    }
    setError(null)
    setAuxiliaryLoading(kind)
    try {
      if (kind === 'bom') {
        const parsed = await parseBomFile(file)
        setBomRowOrientations(new Map())
        setSourceBomData(parsed)
        reconcileBomWithLibrary(parsed, componentLibraryData)
        setBomFile(file)
      } else {
        const parsed = await parsePlacementFile(file)
        setPlacementData(parsed)
        setPlacementFile(file)
        setSelectedBomId(null)
        setBomRowOrientations(new Map())
      }
    } catch (parseError) {
      const label = kind === 'bom' ? 'BOM' : '坐标文件'
      setError(`${label} 解析失败：${parseError instanceof Error ? parseError.message : '文件格式不受支持'}`)
    } finally {
      setAuxiliaryLoading(null)
    }
  }

  const handleImportDrop = (kind: 'gerber' | 'bom' | 'placement', files: File[]) => {
    setDraggingImport(null)
    if (kind === 'gerber') void handleGerberFiles(files)
    else void handleAuxiliaryFile(kind, files[0])
  }

  const clearGerber = () => {
    setBoard(null)
    setGerberImportName('')
    setSelectedBomId(null)
    setBomRowOrientations(new Map())
    setCameraPreset('iso')
    setCameraRevision((revision) => revision + 1)
    setError(null)
  }

  const choosePreset = (preset: CameraPreset) => {
    setCameraPreset(preset)
    setCameraRevision((revision) => revision + 1)
  }

  const toggleVisibility = (key: keyof LayerVisibility) => {
    setVisibility((current) => ({ ...current, [key]: !current[key] }))
  }

  const profileCandidates = board?.profileCandidates.flatMap((id) => {
    const layer = board.layers.find((candidate) => candidate.id === id)
    return layer ? [layer] : []
  }) ?? []
  const importReadyCount = Number(Boolean(board)) + Number(Boolean(bomFile)) + Number(Boolean(placementFile))
  const placementDesignators = useMemo(
    () => new Set(placementData?.placements.map((placement) => placement.designator) ?? []),
    [placementData],
  )
  const bomComponentCount = useMemo(
    () => bomData?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0,
    [bomData],
  )
  const bomDesignatorCount = useMemo(
    () => bomData?.items.reduce((sum, item) => sum + item.designators.length, 0) ?? 0,
    [bomData],
  )
  const matchedDesignatorCount = useMemo(
    () => bomData?.items.reduce((sum, item) => (
      sum + item.designators.filter((designator) => placementDesignators.has(designator)).length
    ), 0) ?? 0,
    [bomData, placementDesignators],
  )
  const placementAlignment = useMemo(
    () => board && placementData ? alignPlacements(board, placementData.placements) : null,
    [board, placementData],
  )
  const selectedDesignators = useMemo(
    () => selectedBomItem?.designators ?? [],
    [selectedBomItem],
  )
  const footprintModelByPath = useMemo(
    () => new Map(footprintModels.map((model) => [model.sourcePath, model])),
    [footprintModels],
  )
  const footprintMatcher = useMemo(
    () => createFootprintModelMatcher(footprintModels),
    [footprintModels],
  )
  const pcbBomItems = useMemo(
    () => (bomData?.items ?? []).filter((item) => bomLibraryMatches.has(item.id)),
    [bomData, bomLibraryMatches],
  )
  const filteredBomItems = useMemo(() => {
    const query = bomQuery.trim().toLocaleLowerCase()
    if (!query) return bomData?.items ?? []
    return (bomData?.items ?? []).filter((item) => [
      ...item.designators,
      item.sku,
      item.materialName,
      item.value,
      item.footprint,
      item.partNumber,
      item.manufacturer,
      item.description,
    ].some((value) => value.toLocaleLowerCase().includes(query)))
  }, [bomData, bomQuery])
  const filteredComponentLibraryItems = useMemo(() => {
    const query = componentLibraryQuery.trim().toLocaleLowerCase()
    return (componentLibraryData?.items ?? []).filter((item) => [
      componentLibraryFieldFilter === null
        || componentLibraryField(item.materialName) === componentLibraryFieldFilter,
      !query || [
        item.sku,
        item.materialName,
        item.specification,
        item.dataStatus,
        item.disabledStatus,
        item.materialProperty,
        item.unit,
        item.used,
      ].some((value) => value.toLocaleLowerCase().includes(query)),
    ].every(Boolean))
  }, [componentLibraryData, componentLibraryFieldFilter, componentLibraryQuery])
  const componentLibraryFields = useMemo(() => {
    const counts = new Map<string, number>()
    componentLibraryData?.items.forEach((item) => {
      const field = componentLibraryField(item.materialName)
      counts.set(field, (counts.get(field) ?? 0) + 1)
    })
    return [...counts.entries()]
      .map(([field, count]) => ({ field, count }))
      .sort((left, right) => right.count - left.count || left.field.localeCompare(right.field, 'zh-CN'))
  }, [componentLibraryData])
  const componentLibraryFootprintMatches = useMemo(() => {
    const matches = new Map<string, NonNullable<ReturnType<typeof footprintMatcher.matchComponentLibraryFootprint>>>()
    componentLibraryData?.items.forEach((item) => {
      const match = footprintMatcher.matchComponentLibraryFootprint(item)
      if (match) matches.set(item.id, match)
    })
    return matches
  }, [componentLibraryData, footprintMatcher])
  const manualLibraryModels = useMemo(() => {
    const bindings = new Map<string, FootprintModel>()
    componentLibraryData?.items.forEach((item) => {
      const modelPath = materialModelBindings[materialModelBindingKey(item)]
      const model = modelPath ? footprintModelByPath.get(modelPath) : undefined
      if (model) bindings.set(item.id, model)
    })
    return bindings
  }, [componentLibraryData, footprintModelByPath, materialModelBindings])
  const manualModelTargetItem = useMemo(
    () => componentLibraryData?.items.find((item) => item.id === manualModelTargetId) ?? null,
    [componentLibraryData, manualModelTargetId],
  )
  const bomFootprintModelOverrides = useMemo(() => {
    const overrides = new Map<string, FootprintModel>()
    bomLibraryMatches.forEach((match, bomItemId) => {
      // 手动绑定优先；未手动绑定时回落到元件库的自动匹配（与元件库表格同一判定）。
      const model = manualLibraryModels.get(match.libraryItem.id)
        ?? componentLibraryFootprintMatches.get(match.libraryItem.id)?.model
      if (model) overrides.set(bomItemId, model)
    })
    return overrides
  }, [bomLibraryMatches, componentLibraryFootprintMatches, manualLibraryModels])
  const bomReplaceTarget = useMemo(() => {
    if (!bomReplaceRequest) return null
    if (bomReplaceRequest.source === 'pending') {
      const entry = pendingBomItems.find((candidate) => candidate.item.id === bomReplaceRequest.id)
      return entry ? { kind: 'pending' as const, item: entry.item, entry } : null
    }
    const item = bomData?.items.find((candidate) => candidate.id === bomReplaceRequest.id)
    return item ? { kind: 'checked' as const, item } : null
  }, [bomData, bomReplaceRequest, pendingBomItems])
  const bomReplaceCandidates = useMemo(() => {
    if (!bomReplaceTarget) return []
    return (componentLibraryData?.items ?? [])
      .map((libraryItem) => ({
        libraryItem,
        score: scoreBomLibraryCandidate(bomReplaceTarget.item, libraryItem),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => (
        right.score - left.score
        || left.libraryItem.materialName.localeCompare(right.libraryItem.materialName, 'zh-CN')
      ))
  }, [bomReplaceTarget, componentLibraryData])
  const confirmedBomItems = useMemo(
    () => bomData?.items.filter((item) => confirmedBomIds.has(item.id)) ?? [],
    [bomData, confirmedBomIds],
  )
  const confirmedBomCount = confirmedBomItems.length
  const bomTableWidth = useMemo(
    () => bomTableColumns.reduce((total, column) => total + bomColumnWidths[column.key], 0),
    [bomColumnWidths],
  )
  const libraryTableWidth = useMemo(
    () => libraryTableColumns.reduce((total, column) => total + libraryColumnWidths[column.key], 0),
    [libraryColumnWidths],
  )

  const setBomColumnWidth = (column: BomColumnDefinition, width: number) => {
    const nextWidth = Math.min(column.maxWidth, Math.max(column.minWidth, Math.round(width)))
    setBomColumnWidths((current) => current[column.key] === nextWidth
      ? current
      : { ...current, [column.key]: nextWidth })
  }

  const startBomColumnResize = (
    event: ReactPointerEvent<HTMLSpanElement>,
    column: BomColumnDefinition,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    bomColumnDragRef.current = {
      key: column.key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: bomColumnWidths[column.key],
    }
    setResizingBomColumn(column.key)
  }

  const moveBomColumnResize = (
    event: ReactPointerEvent<HTMLSpanElement>,
    column: BomColumnDefinition,
  ) => {
    const drag = bomColumnDragRef.current
    if (!drag || drag.key !== column.key || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    setBomColumnWidth(column, drag.startWidth + event.clientX - drag.startX)
  }

  const stopBomColumnResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = bomColumnDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    bomColumnDragRef.current = null
    setResizingBomColumn(null)
  }

  const handleBomColumnResizeKey = (
    event: ReactKeyboardEvent<HTMLSpanElement>,
    column: BomColumnDefinition,
  ) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    setBomColumnWidth(column, bomColumnWidths[column.key] + direction * (event.shiftKey ? 20 : 8))
  }

  const setLibraryColumnWidth = (column: LibraryColumnDefinition, width: number) => {
    const nextWidth = Math.min(column.maxWidth, Math.max(column.minWidth, Math.round(width)))
    setLibraryColumnWidths((current) => current[column.key] === nextWidth
      ? current
      : { ...current, [column.key]: nextWidth })
  }

  const startLibraryColumnResize = (
    event: ReactPointerEvent<HTMLSpanElement>,
    column: LibraryColumnDefinition,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    libraryColumnDragRef.current = {
      key: column.key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: libraryColumnWidths[column.key],
    }
    setResizingLibraryColumn(column.key)
  }

  const moveLibraryColumnResize = (
    event: ReactPointerEvent<HTMLSpanElement>,
    column: LibraryColumnDefinition,
  ) => {
    const drag = libraryColumnDragRef.current
    if (!drag || drag.key !== column.key || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    setLibraryColumnWidth(column, drag.startWidth + event.clientX - drag.startX)
  }

  const stopLibraryColumnResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = libraryColumnDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    libraryColumnDragRef.current = null
    setResizingLibraryColumn(null)
  }

  const handleLibraryColumnResizeKey = (
    event: ReactKeyboardEvent<HTMLSpanElement>,
    column: LibraryColumnDefinition,
  ) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    setLibraryColumnWidth(column, libraryColumnWidths[column.key] + direction * (event.shiftKey ? 20 : 8))
  }

  const toggleBomConfirmation = (itemId: string) => {
    setConfirmedBomIds((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const exportProductionBom = async () => {
    if (confirmedBomItems.length === 0) {
      setError('请先勾选至少一条已核对的 BOM 元件')
      return
    }

    setExportingProductionBom(true)
    try {
      const fileName = productionBomFileName(bomFile)
      // The picker must be opened before the first await to retain the button's user activation.
      const saveHandle = requestProductionBomSaveHandle(fileName)
      const XLSX = await import('xlsx-js-style')
      const projectName = board?.name || bomFile?.name.replace(/\.[^.]+$/, '') || '生产BOM'
      const exportDate = new Date()
      const exportDateSerial = Math.floor(
        Date.UTC(exportDate.getFullYear(), exportDate.getMonth(), exportDate.getDate()) / 86_400_000,
      ) + 25_569
      const rows = confirmedBomItems.map((item, index) => [
        index + 1,
        item.sku,
        item.materialName,
        item.value || item.partNumber,
        item.description,
        item.footprint,
        item.designators.join(', '),
        item.quantity,
        '',
        '',
      ])
      const worksheet = XLSX.utils.aoa_to_sheet([
        ['项目名', '', '', '', '', '', '生产用量', '', '', '日期'],
        [projectName, '', '', '', '', '', '', '', '', exportDateSerial],
        productionBomExportHeaders,
        ...rows,
      ], { cellDates: true })
      worksheet['!cols'] = [
        { width: 8.625 },
        { width: 13.5 },
        { width: 17.5 },
        { width: 36.625 },
        { width: 59.625 },
        { width: 22.125 },
        { width: 80.625 },
        { width: 19.625 },
        { width: 17.375 },
        { width: 38.625 },
      ]
      worksheet['!rows'] = [
        { hpt: 17.1 },
        { hpt: 17.1 },
        { hpt: 17.1 },
      ]
      worksheet['!merges'] = [
        XLSX.utils.decode_range('A1:F1'),
        XLSX.utils.decode_range('A2:F2'),
        XLSX.utils.decode_range('G1:I1'),
        XLSX.utils.decode_range('G2:I2'),
      ]
      worksheet['!autofilter'] = { ref: `A3:J${rows.length + 3}` }

      for (let columnIndex = 0; columnIndex < productionBomExportHeaders.length; columnIndex += 1) {
        const column = XLSX.utils.encode_col(columnIndex)
        worksheet[`${column}1`].s = productionBomInfoStyle
        worksheet[`${column}2`].s = columnIndex === 9 ? {
          ...productionBomInfoStyle,
          numFmt: 'mm-dd-yy',
        } : productionBomInfoStyle
        worksheet[`${column}3`].s = productionBomHeaderStyle
      }
      worksheet.J2.z = 'mm-dd-yy'
      rows.forEach((_, rowIndex) => {
        const sheetRow = rowIndex + 4
        for (let columnIndex = 0; columnIndex < productionBomExportHeaders.length; columnIndex += 1) {
          const column = XLSX.utils.encode_col(columnIndex)
          worksheet[`${column}${sheetRow}`].s = (columnIndex === 0 || columnIndex === 7 || columnIndex === 8)
            ? productionBomNumberStyle
            : productionBomDataStyle
        }
      })

      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, '生产BOM')
      if (saveHandle) {
        const workbookData = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true })
        const fileHandle = await saveHandle
        const writable = await fileHandle.createWritable()
        await writable.write(new Blob([workbookData], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }))
        await writable.close()
      } else {
        XLSX.writeFile(workbook, fileName, { bookType: 'xlsx', compression: true })
      }
      setError(null)
    } catch (exportError) {
      if (isSavePickerCancelled(exportError)) {
        setError(null)
        return
      }
      setError(`生产 BOM 导出失败：${exportError instanceof Error ? exportError.message : '未知错误'}`)
    } finally {
      setExportingProductionBom(false)
    }
  }

  const selectBomItem = (itemId: string) => {
    setSelectedBomId(itemId)
    setBomSelectionRevision((revision) => revision + 1)
  }

  const selectBomItemByDesignator = (designator: string) => {
    const normalizedDesignator = designator.trim().toUpperCase()
    const item = bomData?.items.find((candidate) => candidate.designators.some(
      (candidateDesignator) => candidateDesignator.trim().toUpperCase() === normalizedDesignator,
    ))
    if (!item) return
    setBomQuery('')
    setBomCellEdit(null)
    setSelectedBomId(item.id)
    setBomSelectionRevision((revision) => revision + 1)
  }

  const clearBomSelection = () => {
    setBomCellEdit(null)
    setSelectedBomId(null)
  }

  const startBomCellEdit = (item: BomItem, field: BomCellEdit['field']) => {
    // 已勾选「确认」的行锁定内容：确认过的物料不该被再改掉，先取消勾选再编辑。
    if (confirmedBomIds.has(item.id)) return
    setBomCellEdit({
      itemId: item.id,
      field,
      value: field === 'materialName' ? item.materialName : item.value || item.partNumber,
    })
  }

  const saveBomCellEdit = (edit: BomCellEdit) => {
    const value = edit.value.trim()
    setBomData((current) => current
      ? {
          ...current,
          items: current.items.map((item) => {
            if (item.id !== edit.itemId) return item
            return edit.field === 'materialName'
              ? { ...item, materialName: value }
              : { ...item, value }
          }),
        }
      : current)
    setBomCellEdit((current) => (
      current?.itemId === edit.itemId && current.field === edit.field ? null : current
    ))
  }

  const moveBomItemToPending = (item: BomItem) => {
    const itemIndex = bomData?.items.findIndex((candidate) => candidate.id === item.id) ?? -1
    if (itemIndex < 0) return
    setPendingBomItems((current) => current.some((entry) => entry.item.id === item.id)
      ? current
      : [...current, { item, index: itemIndex }])
    setBomData((current) => current
      ? { ...current, items: current.items.filter((candidate) => candidate.id !== item.id) }
      : current)
    setConfirmedBomIds((current) => {
      const next = new Set(current)
      next.delete(item.id)
      return next
    })
    setSelectedBomId((current) => current === item.id ? null : current)
    setBomRowOrientations((current) => {
      if (!current.has(item.id)) return current
      const next = new Map(current)
      next.delete(item.id)
      return next
    })
    setBomCellEdit((current) => current?.itemId === item.id ? null : current)
    setBomLibraryMatches((current) => {
      const next = new Map(current)
      next.delete(item.id)
      return next
    })
  }

  const restorePendingBomItem = (entry: PendingBomItem) => {
    const libraryMatch = matchBomItemToLibrary(entry.item, componentLibraryData?.items ?? [])
    const restoredItem = libraryMatch
      ? enrichBomItemFromLibrary(entry.item, libraryMatch.libraryItem)
      : entry.item
    setPendingBomItems((current) => current.filter((candidate) => candidate.item.id !== entry.item.id))
    setBomData((current) => {
      if (!current || current.items.some((item) => item.id === entry.item.id)) return current
      const items = [...current.items]
      items.splice(Math.min(entry.index, items.length), 0, restoredItem)
      return { ...current, items }
    })
    if (libraryMatch) {
      setBomLibraryMatches((current) => new Map(current).set(entry.item.id, libraryMatch))
    }
  }

  /** 人工替换的统一落盘：键取「原始 BOM 描述」，重导 BOM 后（无论当时是待处理还是已核对）都能对上同一条。 */
  const persistMaterialMatch = (item: BomItem, libraryItem: ComponentLibraryItem) => {
    const sku = libraryItem.sku.trim()
    if (!sku) return
    const original = sourceBomData?.items.find((candidate) => candidate.id === item.id) ?? item
    const key = materialMatchKey(original)
    if (!key) return
    setMaterialMatches((current) => {
      const next = { ...current, [key]: sku }
      persistMaterialMatches(next)
      return next
    })
  }

  const replacePendingBomItem = (
    entry: PendingBomItem,
    libraryItem: ComponentLibraryItem,
    score: number,
  ) => {
    const replacedItem = enrichBomItemFromLibrary(entry.item, libraryItem)
    setPendingBomItems((current) => current.filter((candidate) => candidate.item.id !== entry.item.id))
    setBomData((current) => {
      if (!current || current.items.some((item) => item.id === entry.item.id)) return current
      const items = [...current.items]
      items.splice(Math.min(entry.index, items.length), 0, replacedItem)
      return { ...current, items }
    })
    setBomLibraryMatches((current) => new Map(current).set(entry.item.id, { libraryItem, score }))
    persistMaterialMatch(entry.item, libraryItem)
  }

  /** 已核对行的替换：行留在核对表格，只换绑定的金蝶物料。 */
  const replaceCheckedBomItem = (
    item: BomItem,
    libraryItem: ComponentLibraryItem,
    score: number,
  ) => {
    setBomData((current) => current
      ? {
          ...current,
          items: current.items.map((candidate) => (
            candidate.id === item.id ? enrichBomItemFromLibrary(candidate, libraryItem) : candidate
          )),
        }
      : current)
    setBomLibraryMatches((current) => new Map(current).set(item.id, { libraryItem, score }))
    // 物料换了，之前对这行的「确认」不再成立。
    setConfirmedBomIds((current) => {
      if (!current.has(item.id)) return current
      const next = new Set(current)
      next.delete(item.id)
      return next
    })
    persistMaterialMatch(item, libraryItem)
  }

  const applyBomReplacePick = (libraryItem: ComponentLibraryItem, score: number) => {
    const target = bomReplaceTarget
    if (!target) return
    if (target.kind === 'pending') replacePendingBomItem(target.entry, libraryItem, score)
    else replaceCheckedBomItem(target.item, libraryItem, score)
    setBomReplaceRequest(null)
  }

  const selectComponentLibraryItem = (itemId: string) => {
    const previewModel = manualLibraryModels.get(itemId)
      ?? componentLibraryFootprintMatches.get(itemId)?.model
    setSelectedLibraryItemId(itemId)
    setSelectedLibraryModelPath(previewModel?.sourcePath ?? null)
  }

  const openManualModelImport = (itemId: string) => {
    selectComponentLibraryItem(itemId)
    setManualModelTargetId(itemId)
  }

  const persistModelBindings = (next: MaterialModelBindings) => {
    saveStringMap(materialModelBindingsStorageKey, next)
    void modelBindingsStore.write(next).then((ok) => {
      if (ok) return
      setError(`模型绑定已存在本机浏览器，但未能写入 ${modelBindingsFileName}（请确认 npm run api 正在运行）`)
    })
  }

  const persistMaterialMatches = (next: StringMap) => {
    saveStringMap(materialMatchesStorageKey, next)
    void materialMatchesStore.write(next).then((ok) => {
      if (ok) return
      setError(`物料核对结果已存在本机浏览器，但未能写入 ${materialMatchesFileName}（请确认 npm run api 正在运行）`)
    })
  }

  const bindManualModel = (item: ComponentLibraryItem, model: FootprintModel) => {
    setMaterialModelBindings((current) => {
      const next = {
        ...current,
        [materialModelBindingKey(item)]: model.sourcePath,
      }
      persistModelBindings(next)
      return next
    })
    setSelectedLibraryItemId(item.id)
    setSelectedLibraryModelPath(model.sourcePath)
    setManualModelTargetId(null)
    setError(null)
  }

  const unbindManualModel = (item: ComponentLibraryItem) => {
    setMaterialModelBindings((current) => {
      const next = { ...current }
      delete next[materialModelBindingKey(item)]
      persistModelBindings(next)
      return next
    })
    setSelectedLibraryItemId(item.id)
    setSelectedLibraryModelPath(componentLibraryFootprintMatches.get(item.id)?.model.sourcePath ?? null)
    setManualModelTargetId(null)
  }

  const closeComponentLibraryPage = () => {
    if (!kingdeeDatabaseConnected || !componentLibraryData) return
    setManualModelTargetId(null)
    setComponentLibraryPageOpen(false)
    setDraggingImport(null)
    setError(null)
  }

  const openComponentLibraryPage = () => {
    setComponentLibraryPageView(
      kingdeeDatabaseConnected && componentLibraryData ? 'materials' : 'connection',
    )
    setComponentLibraryPageOpen(true)
  }

  const renderBomColumnGroup = () => (
    <colgroup>
      {bomTableColumns.map((column) => (
        <col
          className={column.className}
          key={column.key}
          style={{ width: bomColumnWidths[column.key] }}
        />
      ))}
    </colgroup>
  )

  const renderBomTableHeader = () => (
    <thead>
      <tr>
        {bomTableColumns.map((column) => (
          <th
            className={column.headerClassName}
            key={column.key}
            aria-label={column.key === 'check' ? column.label : undefined}
          >
            {column.key !== 'check' && column.label}
            <span
              aria-label={`调整${column.label}列宽`}
              aria-orientation="vertical"
              aria-valuemax={column.maxWidth}
              aria-valuemin={column.minWidth}
              aria-valuenow={bomColumnWidths[column.key]}
              aria-valuetext={`${bomColumnWidths[column.key]} 像素`}
              className={`bom-column-resizer ${resizingBomColumn === column.key ? 'active' : ''}`}
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setBomColumnWidth(column, column.defaultWidth)
              }}
              onKeyDown={(event) => handleBomColumnResizeKey(event, column)}
              onLostPointerCapture={() => {
                if (bomColumnDragRef.current?.key !== column.key) return
                bomColumnDragRef.current = null
                setResizingBomColumn(null)
              }}
              onPointerCancel={stopBomColumnResize}
              onPointerDown={(event) => startBomColumnResize(event, column)}
              onPointerMove={(event) => moveBomColumnResize(event, column)}
              onPointerUp={stopBomColumnResize}
              role="separator"
              tabIndex={0}
              title="拖动调整列宽；双击恢复默认宽度"
            />
          </th>
        ))}
      </tr>
    </thead>
  )

  const renderLibraryColumnGroup = () => (
    <colgroup>
      {libraryTableColumns.map((column) => (
        <col key={column.key} style={{ width: libraryColumnWidths[column.key] }} />
      ))}
    </colgroup>
  )

  const renderLibraryTableHeader = () => (
    <thead>
      <tr>
        {libraryTableColumns.map((column) => (
          <th key={column.key}>
            {column.label}
            <span
              aria-label={`调整${column.label}列宽`}
              aria-orientation="vertical"
              aria-valuemax={column.maxWidth}
              aria-valuemin={column.minWidth}
              aria-valuenow={libraryColumnWidths[column.key]}
              aria-valuetext={`${libraryColumnWidths[column.key]} 像素`}
              className={`library-column-resizer ${resizingLibraryColumn === column.key ? 'active' : ''}`}
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setLibraryColumnWidth(column, column.defaultWidth)
              }}
              onKeyDown={(event) => handleLibraryColumnResizeKey(event, column)}
              onLostPointerCapture={() => {
                if (libraryColumnDragRef.current?.key !== column.key) return
                libraryColumnDragRef.current = null
                setResizingLibraryColumn(null)
              }}
              onPointerCancel={stopLibraryColumnResize}
              onPointerDown={(event) => startLibraryColumnResize(event, column)}
              onPointerMove={(event) => moveLibraryColumnResize(event, column)}
              onPointerUp={stopLibraryColumnResize}
              role="separator"
              tabIndex={0}
              title="拖动调整列宽；双击恢复默认宽度"
            />
          </th>
        ))}
      </tr>
    </thead>
  )

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark"><Layers3 size={18} strokeWidth={2.2} /></span>
          <div>
            <strong>FABVIEW</strong>
            <span>Gerber 3D</span>
          </div>
        </div>

        <div className="project-summary" aria-live="polite">
          <strong>{board?.name ?? '未载入项目'}</strong>
          {board && (
            <span>{board.widthMm.toFixed(2)} × {board.heightMm.toFixed(2)} mm · {board.layers.length} 个图层</span>
          )}
        </div>

        <div className="topbar-actions">
          <button
            className="production-bom-export-button"
            type="button"
            disabled={confirmedBomCount === 0 || exportingProductionBom}
            onClick={() => void exportProductionBom()}
            aria-label="导出生产BOM"
            title={confirmedBomCount > 0
              ? `导出 ${confirmedBomCount} 条已确认的元件`
              : '请先勾选确认的 BOM 元件'}
          >
            {exportingProductionBom ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
            <span>导出生产BOM</span>
          </button>
          <div className="view-segment" aria-label="视图方向">
            <button
              className={cameraPreset === 'iso' ? 'active' : ''}
              onClick={() => choosePreset('iso')}
              title="等轴视图"
              aria-label="等轴视图"
            >
              <Cuboid size={17} />
              <span>3D</span>
            </button>
            <button
              className={cameraPreset === 'top' ? 'active' : ''}
              onClick={() => choosePreset('top')}
              title="顶层视图"
              aria-label="顶层视图"
            >
              <ArrowUpToLine size={17} />
              <span>顶面</span>
            </button>
            <button
              className={cameraPreset === 'bottom' ? 'active' : ''}
              onClick={() => choosePreset('bottom')}
              title="底层视图"
              aria-label="底层视图"
            >
              <ArrowDownToLine size={17} />
              <span>底面</span>
            </button>
          </div>
        </div>
      </header>

      <aside className="sidebar">
        <section className="sidebar-section import-section">
          <div className="section-heading">
            <span>生产文件</span>
            <span className="count-badge">{importReadyCount}/3</span>
          </div>
          <div className="import-list">
            <div
              className={`import-target gerber ${draggingImport === 'gerber' ? 'dragging' : ''} ${board ? 'ready' : ''}`}
              onDragEnter={(event) => {
                event.preventDefault()
                setDraggingImport('gerber')
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setDraggingImport(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                handleImportDrop('gerber', Array.from(event.dataTransfer.files))
              }}
            >
              <FileArchive size={20} />
              <div>
                <strong>Gerber</strong>
                <span title={gerberImportName}>{board ? `${gerberImportName} · ${board.sources.length} 个文件` : 'ZIP / Gerber'}</span>
              </div>
              <div className="import-target-actions">
                <button onClick={() => gerberInputRef.current?.click()} title="导入 Gerber" aria-label="导入 Gerber">
                  <FolderOpen size={16} />
                </button>
                {board && (
                  <button onClick={clearGerber} title="清空 Gerber" aria-label="清空 Gerber">
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>

            <div
              className={`import-target bom ${draggingImport === 'bom' ? 'dragging' : ''} ${bomFile ? 'ready' : ''}`}
              onDragEnter={(event) => {
                event.preventDefault()
                setDraggingImport('bom')
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setDraggingImport(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                handleImportDrop('bom', Array.from(event.dataTransfer.files))
              }}
            >
              <FileSpreadsheet size={20} />
              <div>
                <strong>BOM</strong>
                <span title={bomFile?.name}>{bomFile ? `${bomFile.name} · ${formatBytes(bomFile.size)}` : 'XLSX / XLS / CSV / TSV'}</span>
              </div>
              <button onClick={() => bomInputRef.current?.click()} title="导入 BOM" aria-label="导入 BOM">
                {auxiliaryLoading === 'bom' ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}
              </button>
            </div>

            <div
              className={`import-target placement ${draggingImport === 'placement' ? 'dragging' : ''} ${placementFile ? 'ready' : ''}`}
              onDragEnter={(event) => {
                event.preventDefault()
                setDraggingImport('placement')
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setDraggingImport(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                handleImportDrop('placement', Array.from(event.dataTransfer.files))
              }}
            >
              <MapPin size={20} />
              <div>
                <strong>坐标</strong>
                <span title={placementFile?.name}>{placementFile ? `${placementFile.name} · ${formatBytes(placementFile.size)}` : 'XLSX / CSV / TXT / POS'}</span>
              </div>
              <button onClick={() => placementInputRef.current?.click()} title="导入坐标文件" aria-label="导入坐标文件">
                {auxiliaryLoading === 'placement' ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}
              </button>
            </div>
          </div>

          <input
            ref={gerberInputRef}
            type="file"
            hidden
            multiple
            onChange={(event) => {
              void handleGerberFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <input
            ref={bomInputRef}
            type="file"
            hidden
            accept=".xlsx,.xls,.csv,.tsv"
            onChange={(event) => {
              void handleAuxiliaryFile('bom', event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <input
            ref={placementInputRef}
            type="file"
            hidden
            accept=".xlsx,.xls,.csv,.tsv,.txt,.pos"
            onChange={(event) => {
              void handleAuxiliaryFile('placement', event.target.files?.[0])
              event.target.value = ''
            }}
          />
        </section>

        <section className="sidebar-section library-section">
          <div className="section-heading">
            <span>元件库</span>
            <span className="count-badge">{componentLibraryData?.items.length ?? 0}</span>
          </div>
          <div className="import-list">
            <div
              className={`import-target library ${componentLibraryData ? 'ready' : ''}`}
            >
              <button
                className="library-source-icon-button"
                type="button"
                onClick={openComponentLibraryPage}
                title="打开金蝶 ERP"
                aria-label="打开金蝶 ERP"
              >
                <Database size={20} />
              </button>
              <div>
                <strong>金蝶 ERP</strong>
                <span
                  title={(componentLibraryData?.warnings ?? []).join(' · ')}
                >
                  {componentLibraryData
                    ? `已同步 ${componentLibraryData.items.length} 条电子物料`
                    : '连接 K/3 Cloud 并同步物料'}
                </span>
              </div>
              <button
                type="button"
                onClick={openComponentLibraryPage}
                title="打开金蝶 ERP"
                aria-label="打开金蝶 ERP"
              >
                <Database size={16} />
              </button>
            </div>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>显示</span>
            <span className="count-badge">{Object.values(visibility).filter(Boolean).length}/{visibilityLabels.length}</span>
          </div>
          <div className="visibility-list">
            {visibilityLabels.map((item) => (
              <label key={item.key} className="toggle-row">
                <span className="layer-dot" style={{ backgroundColor: item.color }} />
                <span>{item.label}</span>
                <input
                  type="checkbox"
                  checked={visibility[item.key]}
                  onChange={() => toggleVisibility(item.key)}
                />
                <span className="toggle-track" aria-hidden="true"><span /></span>
              </label>
            ))}
          </div>
        </section>

        <section className="sidebar-section">
          <div className="section-heading"><span>板参数</span></div>
          {board && profileCandidates.length > 0 && (
            <label className="select-field">
              <span>板框来源</span>
              <select
                value={board.profileLayerId}
                disabled={profileCandidates.length === 1}
                onChange={(event) => {
                  setBoard((current) => current ? selectBoardProfile(current, event.target.value) : current)
                  setCameraRevision((revision) => revision + 1)
                }}
              >
                {profileCandidates.map((layer) => (
                  <option key={layer.id} value={layer.id}>{layer.name} · {layer.roleName}</option>
                ))}
              </select>
            </label>
          )}
          <label className="range-field">
            <span>板厚</span>
            <output>{thickness.toFixed(1)} mm</output>
            <input
              type="range"
              min="0.6"
              max="3.2"
              step="0.1"
              value={thickness}
              onChange={(event) => setThickness(Number(event.target.value))}
            />
          </label>
          <div className="color-field">
            <span>阻焊颜色</span>
            <div className="color-swatches">
              {colorOptions.map((option) => (
                <button
                  key={option.value}
                  className={boardColor === option.value ? 'selected' : ''}
                  style={{ '--swatch': option.value } as React.CSSProperties}
                  onClick={() => setBoardColor(option.value)}
                  title={option.name}
                  aria-label={option.name}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="sidebar-section layers-section">
          <div className="section-heading">
            <span>源文件</span>
            <span className="count-badge">{board?.sources.length ?? 0}</span>
          </div>
          <div className="source-list">
            {board?.layers.map((layer) => (
              <div className={`source-row ${layer.id === board.profileLayerId ? 'profile-source' : ''}`} key={layer.id}>
                <span className={`file-status type-${layer.type}`} />
                <div>
                  <strong title={layer.name}>{layer.name}</strong>
                  <span>
                    {layerNames[layer.side ?? ''] ? `${layerNames[layer.side ?? '']} · ` : ''}
                    {layer.roleName}
                  </span>
                </div>
                <span>{formatBytes(board.sources.find((source) => source.name === layer.name)?.size ?? 0)}</span>
              </div>
            ))}
          </div>
        </section>

        {board && board.issues.length > 0 && (
          <section className="sidebar-section issue-section">
            <div className="section-heading">
              <span>解析提示</span>
              <span className="count-badge">{board.issues.length}</span>
            </div>
            <div className="issue-list">
              {board.issues.map((issue, index) => (
                <div className={`issue-row ${issue.level}`} key={`${issue.file ?? 'board'}-${index}`}>
                  <AlertTriangle size={14} />
                  <div>
                    {issue.file && <strong>{issue.file}</strong>}
                    <span>{issue.message}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="data-note">
          <Info size={16} />
          <span>仅显示已通过数据库核对且具有 STEP 封装的元件。</span>
        </section>
      </aside>

      <div className={`content-area ${bomData ? 'with-bom' : ''}`}>
        {bomData && (
          <section className="bom-panel" aria-label="BOM 器件确认">
            <header className="bom-panel-header">
              <div className="bom-panel-title">
                <div>
                  <strong>BOM 器件确认</strong>
                  <span className="count-badge">{bomData.items.length} 种</span>
                </div>
                <span title={bomFile?.name}>{bomFile?.name}</span>
              </div>
              <div className={`bom-confirmation-summary ${confirmedBomCount === bomData.items.length ? 'complete' : ''}`}>
                <CheckCircle2 size={17} />
                <span>已确认</span>
                <strong>{confirmedBomCount}/{bomData.items.length}</strong>
              </div>
            </header>

            <div className="bom-toolbar">
              <div className="bom-summary">
                <span>{bomComponentCount} 件</span>
                <span
                  className={placementAlignment?.status === 'aligned' ? 'aligned' : placementData ? 'partial' : ''}
                  title={placementAlignment
                    ? `${placementAlignment.methodLabel}；${placementAlignment.insideCount}/${placementAlignment.totalCount} 个坐标中心位于板框内`
                    : undefined}
                >
                  {placementAlignment?.status === 'aligned'
                    ? `坐标已对齐 ${placementAlignment.insideCount}/${placementAlignment.totalCount}`
                    : placementData ? `坐标 ${matchedDesignatorCount}/${bomDesignatorCount}` : '待导入坐标'}
                </span>
                <span
                  className={bomLibraryMatches.size === (sourceBomData?.items.length ?? 0) ? 'aligned' : 'partial'}
                  title={`数据库按规格与封装核对；本机 STEP 3D 封装库已加载 ${footprintModels.length} 个模型`}
                >
                  数据库 {bomLibraryMatches.size}/{sourceBomData?.items.length ?? 0} · STEP {bomFootprintModelOverrides.size}/{bomData.items.length}
                </span>
              </div>
              <label className="bom-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={bomQuery}
                  onChange={(event) => setBomQuery(event.target.value)}
                  placeholder="搜索编码、物料名称、规格、名称或位号"
                  aria-label="搜索 BOM"
                />
              </label>
            </div>

            <div className="bom-table-section-label checking">核对元件</div>

            <div
              className={`bom-table-wrap ${resizingBomColumn ? 'resizing-columns' : ''}`}
              ref={bomTableWrapRef}
            >
              <table className="bom-table" style={{ width: bomTableWidth }}>
                {renderBomColumnGroup()}
                {renderBomTableHeader()}
                <tbody>
                  {filteredBomItems.map((item) => {
                    const isConfirmed = confirmedBomIds.has(item.id)
                    const isSelected = selectedBomId === item.id
                    const details = [
                      item.sku,
                      item.materialName,
                      item.partNumber,
                      item.value,
                      item.footprint,
                      item.manufacturer,
                      item.description,
                    ].filter(Boolean).join(' · ')
                    return (
                      <tr
                        aria-selected={isSelected}
                        className={[isConfirmed ? 'confirmed' : '', isSelected ? 'selected' : ''].filter(Boolean).join(' ')}
                        data-bom-id={item.id}
                        key={item.id}
                        onClick={(event) => {
                          // 勾选框 / 动作按钮 / 内联编辑器自己处理点击。
                          // 这里是冒泡阶段而不是捕获阶段：若在捕获阶段就 setState，React 会在
                          // click 的捕获分发结束时先提交一次重渲染，把受控勾选框恢复成未勾选，
                          // 随后的 onChange 检测不到变化 → 勾选框点不动。
                          const target = event.target
                          if (target instanceof Element && target.closest('input, button, .bom-inline-editor')) return
                          selectBomItem(item.id)
                        }}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            selectBomItem(item.id)
                          } else if (event.key === ' ') {
                            event.preventDefault()
                            if (isSelected) adjustSelectedBomRowOrientation('rotationZ')
                            else selectBomItem(item.id)
                          }
                        }}
                        tabIndex={0}
                      >
                        <td className="bom-check-cell">
                          <input
                            type="checkbox"
                            checked={isConfirmed}
                            onChange={() => toggleBomConfirmation(item.id)}
                            aria-label={`确认物料 ${bomPrimaryText(item)}`}
                          />
                        </td>
                        <td className="bom-sku" title={item.sku}>
                          {item.sku || '—'}
                        </td>
                        <td
                          className={`bom-name bom-editable-cell${isConfirmed ? ' locked' : ''}`}
                          title={isConfirmed
                            ? `${item.materialName}（已确认，取消勾选后可编辑）`
                            : item.materialName}
                          onDoubleClick={(event) => {
                            event.stopPropagation()
                            startBomCellEdit(item, 'materialName')
                          }}
                        >
                          {bomCellEdit?.itemId === item.id && bomCellEdit.field === 'materialName' ? (
                            <input
                              autoFocus
                              aria-label={`修改 ${bomPrimaryText(item)} 的物料名称`}
                              className="bom-inline-editor"
                              onBlur={() => saveBomCellEdit(bomCellEdit)}
                              onChange={(event) => setBomCellEdit({ ...bomCellEdit, value: event.target.value })}
                              onFocus={(event) => event.currentTarget.select()}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  event.currentTarget.blur()
                                } else if (event.key === 'Escape') {
                                  event.preventDefault()
                                  setBomCellEdit(null)
                                }
                              }}
                              value={bomCellEdit.value}
                            />
                          ) : item.materialName || '—'}
                        </td>
                        <td
                          className={`bom-spec bom-editable-cell${isConfirmed ? ' locked' : ''}`}
                          title={isConfirmed ? `${details}（已确认，取消勾选后可编辑）` : details}
                          onDoubleClick={(event) => {
                            event.stopPropagation()
                            startBomCellEdit(item, 'spec')
                          }}
                        >
                          {bomCellEdit?.itemId === item.id && bomCellEdit.field === 'spec' ? (
                            <input
                              autoFocus
                              aria-label={`修改 ${bomPrimaryText(item)} 的规格`}
                              className="bom-inline-editor"
                              onBlur={() => saveBomCellEdit(bomCellEdit)}
                              onChange={(event) => setBomCellEdit({ ...bomCellEdit, value: event.target.value })}
                              onFocus={(event) => event.currentTarget.select()}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  event.currentTarget.blur()
                                } else if (event.key === 'Escape') {
                                  event.preventDefault()
                                  setBomCellEdit(null)
                                }
                              }}
                              value={bomCellEdit.value}
                            />
                          ) : <strong>{item.value || item.partNumber || '—'}</strong>}
                        </td>
                        <td className="bom-description" title={item.description}>
                          {item.description || '—'}
                        </td>
                        <td className="bom-footprint" title={item.footprint}>{item.footprint || '—'}</td>
                        <td className="bom-designators" title={item.designators.join(', ')}>
                          {shortDesignators(item.designators)}
                        </td>
                        <td className="bom-quantity">{item.quantity}</td>
                        <td className="bom-actions">
                          {/* 勾选「确认」后整行锁定：既不能改内容，也不能替换/删除。
                              提示挂在这个容器上——禁用的 button 不会弹出自身 title。 */}
                          <div
                            className="bom-action-buttons"
                            title={isConfirmed ? '已确认，取消勾选后可替换或删除元件' : undefined}
                          >
                            <button
                              className="bom-action-button replace"
                              type="button"
                              disabled={isConfirmed}
                              onClick={() => setBomReplaceRequest({ id: item.id, source: 'checked' })}
                              title={isConfirmed ? undefined : `替换元件 ${bomPrimaryText(item)}`}
                            >
                              <RefreshCw size={12} />
                              <span>替换元件</span>
                            </button>
                            <button
                              className="bom-action-button delete"
                              type="button"
                              disabled={isConfirmed}
                              onClick={() => moveBomItemToPending(item)}
                              title={isConfirmed ? undefined : `删除元件 ${bomPrimaryText(item)}`}
                            >
                              <Trash2 size={12} />
                              <span>删除元件</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {filteredBomItems.length === 0 && (
                    <tr>
                      <td className="bom-empty" colSpan={9}>没有匹配的物料</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="bom-table-section-label pending">
              <span>待处理元件</span>
              <span className="pending-bom-count">{pendingBomItems.length}</span>
            </div>

            {pendingBomItems.length > 0 && (
              <div
                className={`bom-table-wrap pending-bom-table-wrap ${resizingBomColumn ? 'resizing-columns' : ''}`}
                aria-label="待处理元件列表"
              >
                <table className="bom-table pending-bom-table" style={{ width: bomTableWidth }}>
                  {renderBomColumnGroup()}
                  {renderBomTableHeader()}
                  <tbody>
                    {pendingBomItems.map((entry) => {
                      const item = entry.item
                      const details = [
                        item.sku,
                        item.materialName,
                        item.partNumber,
                        item.value,
                        item.footprint,
                        item.manufacturer,
                        item.description,
                      ].filter(Boolean).join(' · ')
                      return (
                        <tr key={item.id}>
                          <td className="bom-check-cell" aria-label="待处理元件" />
                          <td className="bom-sku" title={item.sku}>{item.sku || '—'}</td>
                          <td className="bom-name" title={item.materialName}>{item.materialName || '—'}</td>
                          <td className="bom-spec" title={details}>
                            <strong>{item.value || item.partNumber || '—'}</strong>
                          </td>
                          <td className="bom-description" title={item.description}>{item.description || '—'}</td>
                          <td className="bom-footprint" title={item.footprint}>{item.footprint || '—'}</td>
                          <td className="bom-designators" title={item.designators.join(', ')}>
                            {shortDesignators(item.designators)}
                          </td>
                          <td className="bom-quantity">{item.quantity}</td>
                          <td className="bom-actions">
                            <div className="bom-action-buttons pending-actions">
                              <button
                                className="bom-action-button replace"
                                type="button"
                                onClick={() => setBomReplaceRequest({ id: item.id, source: 'pending' })}
                                title={`替换元件 ${bomPrimaryText(item)}`}
                              >
                                <RefreshCw size={12} />
                                <span>替换元件</span>
                              </button>
                              <button
                                className="bom-action-button restore"
                                type="button"
                                onClick={() => restorePendingBomItem(entry)}
                                title={`恢复元件 ${bomPrimaryText(item)}`}
                              >
                                <Undo2 size={12} />
                                <span>恢复元件</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {bomData.warnings.length > 0 && (
              <div className="bom-warning" title={bomData.warnings.join('；')}>
                <AlertTriangle size={14} />
                <span>{bomData.warnings[0]}</span>
              </div>
            )}
          </section>
        )}

        <section className="workspace" aria-label="PCB 3D 视图">
          <PcbViewer
            board={board}
            thickness={thickness}
            boardColor={boardColor}
            visibility={visibility}
            cameraPreset={cameraPreset}
            cameraRevision={cameraRevision}
            alignment={placementAlignment}
            bomItems={pcbBomItems}
            footprintModelOverrides={bomFootprintModelOverrides}
            selectedDesignators={selectedDesignators}
            selectionRevision={bomSelectionRevision}
            bomRowOrientations={bomRowOrientations}
            onComponentSelect={selectBomItemByDesignator}
            onClearSelection={clearBomSelection}
          />

          <div className="bom-row-orientation-controls" aria-label="选中 BOM 行方向与位置调整">
            <button
              disabled={!selectedBomItem}
              onClick={() => adjustSelectedBomRowOrientation('rotationZ')}
              title={selectedBomItem
                ? `将当前行的 ${selectedBomItem.designators.join(', ')} 水平旋转 90°`
                : '先选择一条 BOM 核对行'}
              type="button"
            >
              <RotateCw size={15} />
              <span>90°旋转</span>
            </button>
            <button
              disabled={!selectedBomItem}
              onClick={() => adjustSelectedBomRowOrientation('rotationX')}
              title={selectedBomItem
                ? `将当前行的 ${selectedBomItem.designators.join(', ')} 竖直翻转 90°`
                : '先选择一条 BOM 核对行'}
              type="button"
            >
              <FlipVertical2 size={15} />
              <span>90°翻转</span>
            </button>
            {bomRowNudgeControls.map(({ axis, direction, label, hint, Icon }) => (
              <button
                disabled={!selectedBomItem}
                key={`${axis}-${direction}`}
                onClick={() => nudgeSelectedBomRow(axis, direction)}
                title={selectedBomItem
                  ? `将当前行的 ${selectedBomItem.designators.join(', ')} ${hint} ${bomRowNudgeStepMm} mm`
                  : '先选择一条 BOM 核对行'}
                type="button"
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {loading.active && (
            <div className="processing-overlay" role="status">
              <LoaderCircle className="spin" size={24} />
              <strong>正在构建 PCB</strong>
              <span title={loading.file}>{loading.file}</span>
              <div className="progress-track"><span style={{ width: `${loading.progress}%` }} /></div>
            </div>
          )}

          {error && (
            <div className="error-banner" role="alert">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button onClick={() => setError(null)} title="关闭" aria-label="关闭"><X size={16} /></button>
            </div>
          )}

          {board && !loading.active && (
            <div className="render-status">
              {board.issues.some((issue) => issue.level === 'error') ? (
                <AlertTriangle size={15} />
              ) : (
                <CheckCircle2 size={15} />
              )}
              <span>{board.hasOutline ? '板框已识别' : '使用外接矩形板框'}</span>
            </div>
          )}

          {placementAlignment && !loading.active && (
            <div
              className={`placement-status ${placementAlignment.status}`}
              title={[
                placementAlignment.methodLabel,
                `偏移 X ${placementAlignment.offsetXmm.toFixed(3)} mm，Y ${placementAlignment.offsetYmm.toFixed(3)} mm`,
                ...placementAlignment.placements
                  .filter((placement) => !placement.isInsideBoard)
                  .slice(0, 6)
                  .map((placement) => `板框外 ${placement.designator}: (${placement.boardXmm.toFixed(3)}, ${placement.boardYmm.toFixed(3)}) mm`),
              ].join('；')}
            >
              {placementAlignment.status === 'aligned' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              <span>
                {placementAlignment.status === 'aligned'
                  ? `坐标已自动对齐 · ${placementAlignment.insideCount}/${placementAlignment.totalCount} 在板内`
                  : placementAlignment.status === 'estimated'
                    ? `坐标为估算对齐 · ${placementAlignment.insideCount}/${placementAlignment.totalCount} 在板内`
                    : `坐标超出板框 · ${placementAlignment.insideCount}/${placementAlignment.totalCount} 在板内`}
              </span>
            </div>
          )}
        </section>
      </div>

      <footer className="statusbar">
        <span>{board ? `${board.sources.length} 个文件 · ${formatBytes(board.sources.reduce((sum, file) => sum + file.size, 0))}` : '无数据'}</span>
        <span>{board?.issues.length ? `${board.issues.length} 条解析提示` : '解析正常'}</span>
        <span>WebGL</span>
      </footer>

      {bomReplaceTarget && componentLibraryData && (
        <BomItemReplacePicker
          candidates={bomReplaceCandidates}
          currentSku={bomReplaceTarget.kind === 'checked' ? bomReplaceTarget.item.sku : ''}
          footprintMatches={componentLibraryFootprintMatches}
          item={bomReplaceTarget.item}
          libraryItems={componentLibraryData.items}
          mode={bomReplaceTarget.kind}
          onClose={() => setBomReplaceRequest(null)}
          onPick={applyBomReplacePick}
        />
      )}

      {componentLibraryPageOpen && (
        <section className="library-page" role="dialog" aria-modal="true" aria-label="金蝶 ERP 元件库">
          <header className="library-page-header">
            <div className="library-page-title">
              <span className="library-page-mark"><Database size={19} /></span>
              <div>
                <strong>金蝶 ERP</strong>
                <span>
                  {componentLibraryData
                    ? `已同步 ${componentLibraryData.items.length} 条电子物料`
                    : '配置 K/3 Cloud 连接并同步电子物料'}
                </span>
              </div>
            </div>
            {componentLibraryPageView === 'materials' && (
              <div className="library-header-actions">
                <button
                  className="library-back-button"
                  type="button"
                  aria-label="返回 PCB"
                  title="返回 PCB"
                  onClick={closeComponentLibraryPage}
                >
                  <X size={16} />
                  <span>返回 PCB</span>
                </button>
              </div>
            )}
          </header>

          {componentLibraryPageView === 'connection' ? (
            <KingdeeConnectionPanel
              onConnectionChange={setKingdeeDatabaseConnected}
              onEnter={async () => {
                await syncComponentLibraryFromKingdee()
                setComponentLibraryPageOpen(false)
                setDraggingImport(null)
                setError(null)
              }}
            />
          ) : (
          <div className="library-page-body">
            <aside className="library-import-pane">
              <div className="library-pane-heading">
                <span>金蝶数据源</span>
                <span className="count-badge">{componentLibraryData?.items.length ?? 0}</span>
              </div>
              <div className={`kingdee-sync-panel ${componentLibraryData ? 'ready' : ''}`}>
                {kingdeeSyncing
                  ? <LoaderCircle className="spin" size={28} />
                  : componentLibraryData
                    ? <CheckCircle2 size={28} />
                    : <CloudDownload size={28} />}
                <strong>{kingdeeSyncing ? '正在同步电子物料' : componentLibraryData ? '金蝶物料已同步' : '等待同步物料'}</strong>
                <span>
                  {componentLibraryData
                    ? `${componentLibraryData.items.length} 条 · ${kingdeeLastSync?.toLocaleTimeString('zh-CN', { hour12: false }) ?? '本次会话'}`
                    : '读取编码 21 至 29 开头的电子物料'}
                </span>
                <button
                  className="primary-button"
                  type="button"
                  aria-label={componentLibraryData ? '重新同步金蝶物料' : '同步金蝶物料'}
                  title={componentLibraryData ? '重新同步金蝶物料' : '同步金蝶物料'}
                  disabled={kingdeeSyncing}
                  onClick={() => void syncComponentLibraryFromKingdee().catch(() => undefined)}
                >
                  {kingdeeSyncing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                  <span>{componentLibraryData ? '重新同步' : '同步物料'}</span>
                </button>
              </div>

              {componentLibraryData && (
                <div className="library-file-details">
                  <div>
                    <span>当前数据源</span>
                    <strong>金蝶 K/3 Cloud · BD_MATERIAL</strong>
                  </div>
                  <dl>
                    <div><dt>数据源</dt><dd>{componentLibraryData.sheetName}</dd></div>
                    <div><dt>查询范围</dt><dd>编码 21–29</dd></div>
                    <div><dt>有效物料</dt><dd>{componentLibraryData.items.length} 条</dd></div>
                    <div><dt>同步方式</dt><dd>WebAPI</dd></div>
                  </dl>
                </div>
              )}

              {componentLibraryData && componentLibraryData.warnings.length > 0 && (
                <div className="library-warning-list">
                  {componentLibraryData.warnings.map((warning) => (
                    <div key={warning}><AlertTriangle size={14} /><span>{warning}</span></div>
                  ))}
                </div>
              )}

              {footprintModelsLoading && (
                <div className="library-model-catalog-status" role="status">
                  <LoaderCircle className="spin" size={14} />
                  <span>正在读取本机 STEP 3D 封装库…</span>
                </div>
              )}
              {footprintModelsError && (
                <div className="library-model-catalog-status error" role="alert">
                  <AlertTriangle size={14} />
                  <span>{footprintModelsError}</span>
                  <button
                    type="button"
                    onClick={() => void refreshFootprintModels().catch(() => undefined)}
                    title="重新读取模型库"
                    aria-label="重新读取模型库"
                  >
                    <RefreshCw size={13} />
                  </button>
                </div>
              )}

              <FootprintModelBrowser
                models={footprintModels}
                selectedModelPath={selectedLibraryModelPath}
                onSelectedModelPathChange={setSelectedLibraryModelPath}
              />
            </aside>

            <section className="library-data-pane" aria-label="元件库物料数据">
              <header className="library-data-toolbar">
                <div>
                  <strong>物料数据</strong>
                  <span>
                    {componentLibraryData
                      ? `显示 ${filteredComponentLibraryItems.length} / ${componentLibraryData.items.length} 条${componentLibraryFieldFilter ? ` · ${componentLibraryFieldFilter}` : ''}`
                      : '等待导入'}
                  </span>
                </div>
                <label className="library-search">
                  <Search size={15} />
                  <input
                    type="search"
                    value={componentLibraryQuery}
                    disabled={!componentLibraryData}
                    onChange={(event) => setComponentLibraryQuery(event.target.value)}
                    placeholder="搜索编码、名称或规格"
                    aria-label="搜索元件库"
                  />
                </label>
              </header>

              <div className="library-data-body">
                {componentLibraryData && (
                  <nav className="library-field-nav" aria-label="字段导航">
                    <div className="library-field-nav-heading">
                      <span>字段导航</span>
                      <span>{componentLibraryFields.length}</span>
                    </div>
                    <button
                      className={componentLibraryFieldFilter === null ? 'active' : ''}
                      type="button"
                      onClick={() => setComponentLibraryFieldFilter(null)}
                      aria-pressed={componentLibraryFieldFilter === null}
                    >
                      <span>全部</span>
                      <strong>{componentLibraryData.items.length}</strong>
                    </button>
                    {componentLibraryFields.map(({ field, count }) => (
                      <button
                        className={componentLibraryFieldFilter === field ? 'active' : ''}
                        type="button"
                        key={field}
                        onClick={() => setComponentLibraryFieldFilter(field)}
                        aria-label={`筛选字段 ${field}，${count} 条`}
                        aria-pressed={componentLibraryFieldFilter === field}
                      >
                        <span title={field}>{field}</span>
                        <strong>{count}</strong>
                      </button>
                    ))}
                  </nav>
                )}

                <div className={`library-table-wrap ${resizingLibraryColumn ? 'resizing-columns' : ''}`}>
                  {componentLibraryData ? (
                    <table className="library-table" style={{ width: libraryTableWidth }}>
                      {renderLibraryColumnGroup()}
                      {renderLibraryTableHeader()}
                      <tbody>
                        {filteredComponentLibraryItems.map((item) => {
                          const manualModel = manualLibraryModels.get(item.id)
                          const automaticMatch = componentLibraryFootprintMatches.get(item.id)
                          const matchedModel = manualModel ?? automaticMatch?.model
                          const matchedPackageName = manualModel?.name
                            ?? automaticMatch?.packageName
                            ?? '待匹配'
                          const modelTitle = manualModel
                            ? `手动绑定：${manualModel.name}`
                            : automaticMatch
                              ? `${automaticMatch.forced ? '强绑定' : '自动匹配'}：${automaticMatch.packageName} → ${automaticMatch.source.file}`
                              : '未匹配到实际3D封装'
                          return (
                            <tr
                              key={item.id}
                              className={selectedLibraryItemId === item.id ? 'selected' : ''}
                              aria-selected={selectedLibraryItemId === item.id}
                              onClick={() => selectComponentLibraryItem(item.id)}
                            >
                              <td className="library-sku" title={item.sku}>{item.sku || '—'}</td>
                              <td className="library-name" title={componentLibraryDisplayName(item.materialName)}>
                                {componentLibraryDisplayName(item.materialName) || '—'}
                              </td>
                              <td>{item.dataStatus || '—'}</td>
                              <td>{item.disabledStatus || '—'}</td>
                              <td title={matchedModel ? modelTitle : '待匹配'}>{matchedPackageName}</td>
                              <td className="library-model-cell" title={modelTitle}>
                                {matchedModel ? (
                                  <div className="library-model-actions">
                                    <span className="library-model-status"><CheckCircle2 size={13} />已匹配</span>
                                    <button
                                      className="library-model-replace-button"
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        openManualModelImport(item.id)
                                      }}
                                      title={`替换模型：${matchedModel.name}`}
                                      aria-label={`替换 ${item.sku || item.materialName} 的3D模型`}
                                    >
                                      <RefreshCw size={12} />
                                      <span>替换模型</span>
                                    </button>
                                  </div>
                                ) : (
                                  <div className="library-model-actions">
                                    <span className="library-model-status-placeholder" aria-hidden="true" />
                                    <button
                                      className="library-model-import-button"
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        openManualModelImport(item.id)
                                      }}
                                    >
                                      <Upload size={13} />
                                      <span>手动导入</span>
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                        {filteredComponentLibraryItems.length === 0 && (
                          <tr><td className="library-table-empty" colSpan={6}>没有匹配的物料</td></tr>
                        )}
                      </tbody>
                    </table>
                  ) : (
                    <div className="library-empty-state">
                      <Database size={34} />
                      <strong>{kingdeeSyncing ? '正在同步金蝶物料' : '尚未同步元件库'}</strong>
                      <span>{kingdeeSyncing ? '数据读取完成后会自动显示' : '请先返回连接配置保存账号并同步'}</span>
                    </div>
                  )}
                </div>
              </div>
            </section>
          </div>
          )}

          {error && (
            <div className="error-banner library-page-error" role="alert">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button onClick={() => setError(null)} title="关闭" aria-label="关闭"><X size={16} /></button>
            </div>
          )}

          {manualModelTargetItem && (
            <StepModelPicker
              initialModelPath={
                manualLibraryModels.get(manualModelTargetItem.id)?.sourcePath
                ?? componentLibraryFootprintMatches.get(manualModelTargetItem.id)?.model.sourcePath
              }
              item={manualModelTargetItem}
              models={footprintModels}
              onModelsImported={refreshFootprintModels}
              onBind={(model) => bindManualModel(manualModelTargetItem, model)}
              onClose={() => setManualModelTargetId(null)}
              onUnbind={manualLibraryModels.has(manualModelTargetItem.id)
                ? () => unbindManualModel(manualModelTargetItem)
                : undefined}
            />
          )}
        </section>
      )}
    </main>
  )
}

export default App
