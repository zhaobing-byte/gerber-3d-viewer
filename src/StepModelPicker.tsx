import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronRight,
  Cog,
  Cpu,
  Cuboid,
  FileUp,
  Layers3,
  LoaderCircle,
  Plug,
  Radio,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import type { ComponentLibraryItem } from './assembly-data'
import type { FootprintModel } from './footprint-library'
import { normalizeFootprintName } from './footprint-library'
import FootprintModelBrowser from './FootprintModelBrowser'
import { footprintCategoryOf, summarizeFootprintCategories } from './footprint-categories'
import {
  footprintAutoCategory,
  footprintModelAccept,
  footprintUploadLimit,
  importFootprintArchive,
  importFootprintModel,
  isFootprintArchive,
  isSupportedFootprintUpload,
  type FootprintArchiveResult,
  type FootprintImportResult,
} from './footprint-import-api'

interface StepModelPickerProps {
  item: ComponentLibraryItem
  models: FootprintModel[]
  initialModelPath?: string | null
  onModelsImported?: () => Promise<void>
  onBind: (model: FootprintModel) => void
  onClose: () => void
  onUnbind?: () => void
}

const allModelsCategory = 'all'
const modelSuffix = /\.(?:glb|step|stp)$/i

/** 大类图标，与 `footprint-categories.ts` 的大类 key 对应。 */
const groupIcons: Record<string, typeof Cuboid> = {
  passive: Zap,
  semiconductor: Cpu,
  connector: Plug,
  electromechanical: Cog,
  sensor: Radio,
  mechanical: Wrench,
  other: Boxes,
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 本次会话导入的模型优先于同名索引条目。 */
function mergeModels(base: FootprintModel[], extra: FootprintModel[]): FootprintModel[] {
  if (extra.length === 0) return base
  const byPath = new Map(base.map((model) => [model.sourcePath, model]))
  extra.forEach((model) => byPath.set(model.sourcePath, model))
  return [...byPath.values()]
}

export default function StepModelPicker({
  item,
  models,
  initialModelPath,
  onModelsImported,
  onBind,
  onClose,
  onUnbind,
}: StepModelPickerProps) {
  const [sessionModels, setSessionModels] = useState<FootprintModel[]>([])
  const sessionUrlsRef = useRef<string[]>([])

  const sortedModels = useMemo(
    () => [...mergeModels(models, sessionModels)]
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    [models, sessionModels],
  )
  const modelGroups = useMemo(
    () => summarizeFootprintCategories(sortedModels.map((model) => model.sourcePath)),
    [sortedModels],
  )
  const categoryCount = modelGroups.reduce((total, group) => total + group.categories.length, 0)

  const initialModel = sortedModels.find((model) => model.sourcePath === initialModelPath)
  const [activeCategory, setActiveCategory] = useState(
    initialModel ? footprintCategoryOf(initialModel.sourcePath).key : allModelsCategory,
  )
  const [selectedPath, setSelectedPath] = useState(
    initialModel?.sourcePath ?? sortedModels[0]?.sourcePath ?? '',
  )
  // 默认只展开命中的大类，其余收拢，避免一次性铺开上百个细分分类。
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(() => {
    const activeGroupKey = initialModel ? footprintCategoryOf(initialModel.sourcePath).groupKey : ''
    return modelGroups
      .filter((group) => group.key !== activeGroupKey)
      .map((group) => group.key)
  })
  const dialogRef = useRef<HTMLElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [importFile, setImportFile] = useState<File | null>(null)
  const [importTarget, setImportTarget] = useState('')
  const [importState, setImportState] = useState<'idle' | 'uploading'>('idle')
  const [importResult, setImportResult] = useState<FootprintImportResult | null>(null)
  const [importArchiveResult, setImportArchiveResult] = useState<FootprintArchiveResult | null>(null)
  const [importError, setImportError] = useState('')

  const visibleModels = useMemo(
    () => activeCategory === allModelsCategory
      ? sortedModels
      : sortedModels.filter((model) => footprintCategoryOf(model.sourcePath).key === activeCategory),
    [activeCategory, sortedModels],
  )
  const selectedModel = sortedModels.find((model) => model.sourcePath === selectedPath)
  const selectedCategory = selectedModel ? footprintCategoryOf(selectedModel.sourcePath) : null
  const defaultImportTarget = selectedCategory?.folder
    || modelGroups[0]?.categories[0]?.folder
    || ''

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => () => {
    sessionUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    sessionUrlsRef.current = []
  }, [])

  useEffect(() => {
    if (selectedPath && sortedModels.some((model) => model.sourcePath === selectedPath)) return
    setSelectedPath(sortedModels[0]?.sourcePath ?? '')
  }, [selectedPath, sortedModels])

  const chooseCategory = (category: string) => {
    setActiveCategory(category)
    const nextModels = category === allModelsCategory
      ? sortedModels
      : sortedModels.filter((model) => footprintCategoryOf(model.sourcePath).key === category)
    if (!nextModels.some((model) => model.sourcePath === selectedPath)) {
      setSelectedPath(nextModels[0]?.sourcePath ?? '')
    }
  }

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((current) => (
      current.includes(groupKey)
        ? current.filter((key) => key !== groupKey)
        : [...current, groupKey]
    ))
  }

  const resetImportPanel = () => {
    setImportFile(null)
    setImportResult(null)
    setImportArchiveResult(null)
    setImportError('')
    setImportState('idle')
  }

  const openImportPicker = () => {
    resetImportPanel()
    fileInputRef.current?.click()
  }

  const refreshModelsAfterImport = async () => {
    if (!onModelsImported) return
    try {
      await onModelsImported()
    } catch {
      setImportError('模型已写入本机库，但刷新目录失败；关闭选择器后重新打开即可读取。')
    }
  }

  const handleImportInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 清空 value，允许再次选择同一个文件。
    event.target.value = ''
    if (!file) return
    setImportResult(null)
    setImportArchiveResult(null)
    setImportState('idle')
    if (!isSupportedFootprintUpload(file)) {
      setImportFile(file)
      setImportError('仅支持 .step / .stp / .glb 模型文件或 .zip 压缩包')
      return
    }
    const limit = footprintUploadLimit(file)
    if (file.size > limit) {
      setImportFile(file)
      setImportError(`${isFootprintArchive(file) ? '压缩包' : '文件'}超过 ${formatBytes(limit)} 上限`)
      return
    }
    setImportError('')
    // 库为空时压缩包用「按包内分类自动归位」档位；单个模型必须有真实分类目录，
    // 保持空值以禁用确认按钮。
    setImportTarget(
      isFootprintArchive(file) ? defaultImportTarget || footprintAutoCategory : defaultImportTarget,
    )
    setImportFile(file)
  }

  const confirmImport = async () => {
    if (!importFile || !importTarget) return
    setImportState('uploading')
    setImportError('')
    try {
      if (isFootprintArchive(importFile)) {
        const archive = await importFootprintArchive(importTarget, importFile)
        setImportArchiveResult(archive)
        await refreshModelsAfterImport()
        setImportState('idle')
        return
      }
      const result = await importFootprintModel(importTarget, importFile)
      const objectUrl = URL.createObjectURL(importFile)
      sessionUrlsRef.current.push(objectUrl)
      const isGlb = /\.glb$/i.test(result.filename)
      const sessionModel: FootprintModel = {
        name: result.filename.replace(modelSuffix, ''),
        normalizedName: normalizeFootprintName(result.filename),
        sourcePath: result.source_path,
        url: isGlb ? objectUrl : '',
        stepUrl: isGlb ? undefined : objectUrl,
      }
      setSessionModels((current) => [
        ...current.filter((model) => model.sourcePath !== sessionModel.sourcePath),
        sessionModel,
      ])
      const category = footprintCategoryOf(sessionModel.sourcePath)
      setCollapsedGroups((current) => current.filter((key) => key !== category.groupKey))
      setActiveCategory(category.key)
      setSelectedPath(sessionModel.sourcePath)
      setImportResult(result)
      await refreshModelsAfterImport()
      setImportState('idle')
    } catch (error) {
      setImportState('idle')
      setImportError(error instanceof Error ? error.message : '模型导入失败')
    }
  }

  const importingArchive = importFile ? isFootprintArchive(importFile) : false

  return (
    <div className="step-picker-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        aria-label={`为物料 ${item.sku || item.materialName} 选择 STEP 模型`}
        aria-modal="true"
        className="step-picker-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          // 阻断冒泡，避免 App 的全局 Escape 监听直接把整个元件库页关掉。
          event.stopPropagation()
          if (importFile) {
            resetImportPanel()
            return
          }
          onClose()
        }}
      >
        <header className="step-picker-header">
          <div className="step-picker-title">
            <span><Cuboid size={19} /></span>
            <div>
              <strong>选择 STEP 3D 封装</strong>
              <small title={item.materialName}>{item.sku || '未编码'} · {item.materialName}</small>
            </div>
          </div>
          <button type="button" onClick={onClose} title="关闭" aria-label="关闭 STEP 模型浏览器">
            <X size={17} />
          </button>
        </header>

        <div className="step-picker-body">
          <nav className="step-picker-categories" aria-label="STEP 模型分类">
            <div className="step-picker-category-heading">
              <Layers3 size={14} />
              <span>模型分类</span>
            </div>
            <p className="step-picker-category-summary">
              <strong>{sortedModels.length}</strong> 个模型 · <strong>{categoryCount}</strong> 个分类
            </p>
            <button
              aria-pressed={activeCategory === allModelsCategory}
              className={`step-picker-category-all${activeCategory === allModelsCategory ? ' active' : ''}`}
              onClick={() => chooseCategory(allModelsCategory)}
              type="button"
            >
              <Boxes size={13} />
              <span>全部模型</span>
              <strong>{sortedModels.length}</strong>
            </button>
            {modelGroups.map((group) => {
              const GroupIcon = groupIcons[group.key] ?? Boxes
              const collapsed = collapsedGroups.includes(group.key)
              const holdsActive = group.categories.some((category) => category.key === activeCategory)
              return (
                <section className={holdsActive ? 'step-picker-group active' : 'step-picker-group'} key={group.key}>
                  <button
                    aria-expanded={!collapsed}
                    className="step-picker-group-toggle"
                    onClick={() => toggleGroup(group.key)}
                    type="button"
                  >
                    <span className="step-picker-group-mark"><GroupIcon size={14} /></span>
                    <span className="step-picker-group-text">
                      <strong>{group.label}</strong>
                      <small>{group.hint}</small>
                    </span>
                    <em>{group.count}</em>
                    <ChevronRight
                      className={`step-picker-group-arrow${collapsed ? '' : ' open'}`}
                      size={13}
                    />
                  </button>
                  {!collapsed && (
                    <div className="step-picker-group-items">
                      {group.categories.map((category) => (
                        <button
                          aria-pressed={activeCategory === category.key}
                          className={activeCategory === category.key ? 'active' : ''}
                          key={category.key}
                          onClick={() => chooseCategory(category.key)}
                          title={`${group.label} / ${category.label}`}
                          type="button"
                        >
                          <span>{category.label}</span>
                          <strong>{category.count}</strong>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </nav>

          <div className="step-picker-browser">
            <FootprintModelBrowser
              models={visibleModels}
              onSelectedModelPathChange={setSelectedPath}
              selectedModelPath={selectedPath}
            />
          </div>
        </div>

        <footer className="step-picker-footer">
          <div>
            <span>当前选择</span>
            <strong title={selectedModel?.sourcePath}>{selectedModel?.name ?? '未选择模型'}</strong>
            {selectedCategory && (
              <small title={`${selectedCategory.groupLabel} / ${selectedCategory.label}`}>
                {selectedCategory.groupLabel} · {selectedCategory.label}
              </small>
            )}
          </div>
          <div className="step-picker-actions">
            <input
              accept={footprintModelAccept}
              className="step-picker-file-input"
              onChange={handleImportInput}
              ref={fileInputRef}
              type="file"
            />
            <button className="step-picker-import" onClick={openImportPicker} type="button">
              <FileUp size={14} />
              <span>导入 3D 封装</span>
            </button>
            {onUnbind && (
              <button className="step-picker-unbind" onClick={onUnbind} type="button">解除绑定</button>
            )}
            <button className="step-picker-cancel" onClick={onClose} type="button">取消</button>
            <button
              className="step-picker-bind"
              disabled={!selectedModel}
              onClick={() => selectedModel && onBind(selectedModel)}
              type="button"
            >
              <Check size={15} />
              <span>绑定所选模型</span>
            </button>
          </div>
        </footer>

        {importFile && (
          <div
            className="step-picker-import-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) resetImportPanel()
            }}
          >
            <section aria-label="导入 3D 封装" aria-modal="true" className="step-picker-import" role="dialog">
              <header className="step-picker-import-header">
                <span><FileUp size={16} /></span>
                <div>
                  <strong>导入 3D 封装</strong>
                  <small title={item.materialName}>{item.sku || '未编码'} · {item.materialName}</small>
                </div>
                <button aria-label="关闭导入面板" onClick={resetImportPanel} title="关闭" type="button">
                  <X size={15} />
                </button>
              </header>

              <div className="step-picker-import-body">
                <dl className="step-picker-import-file">
                  <div><dt>文件</dt><dd title={importFile.name}>{importFile.name}</dd></div>
                  <div><dt>大小</dt><dd>{formatBytes(importFile.size)}</dd></div>
                  <div>
                    <dt>类型</dt>
                    <dd>{importingArchive ? 'ZIP 压缩包（批量解压）' : '单个模型文件'}</dd>
                  </div>
                </dl>

                <label className="step-picker-import-target">
                  <span>{importingArchive ? '默认写入分类' : '写入分类'}</span>
                  <select
                    disabled={Boolean(importResult) || Boolean(importArchiveResult)}
                    onChange={(event) => setImportTarget(event.target.value)}
                    value={importTarget}
                  >
                    {categoryCount === 0 && importingArchive && (
                      <option value={footprintAutoCategory}>按包内分类自动归位（库为空）</option>
                    )}
                    {modelGroups.map((group) => (
                      <optgroup key={group.key} label={group.label}>
                        {group.categories.map((category) => (
                          <option key={category.key} value={category.folder}>
                            {category.label}（{category.count}）
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>

                {importResult ? (
                  <p className="step-picker-import-result" role="status">
                    <Check size={15} />
                    <span>
                      已写入 <code>{importResult.source_path}</code>
                      {importResult.overwritten ? '（覆盖了同名文件）' : ''}。
                      已加入本次会话的「{footprintCategoryOf(importResult.source_path).label}」分类，可直接预览与绑定；
                      模型目录已刷新，可立即用于物料绑定和 PCB 3D 展示。
                    </span>
                  </p>
                ) : importArchiveResult ? (
                  <div className="step-picker-import-report" role="status">
                    <p className="step-picker-import-result">
                      <Check size={15} />
                      <span>
                        已从 <code>{importArchiveResult.archive}</code> 写入
                        <strong>{importArchiveResult.written}</strong> 个模型
                        {importArchiveResult.overwritten > 0
                          ? `，覆盖 ${importArchiveResult.overwritten} 个同名文件`
                          : ''}
                        {importArchiveResult.duplicate_names > 0
                          ? `，${importArchiveResult.duplicate_names} 个条目归位后指向同一路径`
                          : ''}
                        {importArchiveResult.skipped_count > 0
                          ? `，跳过 ${importArchiveResult.skipped_count} 个条目`
                          : ''}
                        ，用时 {importArchiveResult.elapsed_ms} ms。
                      </span>
                    </p>
                    {importArchiveResult.categories.length > 0 && (
                      <ul className="step-picker-import-breakdown">
                        {importArchiveResult.categories.map((entry) => (
                          <li key={entry.category}>
                            <span>{entry.category}</span>
                            <strong>{entry.count}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                    {importArchiveResult.skipped.length > 0 && (
                      <details className="step-picker-import-skipped">
                        <summary>已跳过条目（前 {importArchiveResult.skipped.length} 条）</summary>
                        <ul>
                          {importArchiveResult.skipped.map((entry) => (
                            <li key={entry.entry}>
                              <code>{entry.entry}</code>
                              <span>{entry.reason}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {importArchiveResult.created_categories.length > 0 && (
                      <p className="step-picker-import-hint">
                        <AlertTriangle size={14} />
                        <span>
                          新建分类 {importArchiveResult.created_categories.length} 个：<code>{importArchiveResult.created_categories.slice(0, 8).join('、')}</code>
                          {importArchiveResult.created_categories.length > 8 ? ' …' : ''}。未登记到 <code>footprint-categories.ts</code> 的分类会归入「其他」大类。
                        </span>
                      </p>
                    )}
                    <p className="step-picker-import-hint">
                      <AlertTriangle size={14} />
                      <span>
                        模型目录已刷新，这批模型可立即在分类中浏览、绑定并用于 PCB 3D 展示。
                      </span>
                    </p>
                  </div>
                ) : (
                  <p className="step-picker-import-hint">
                    <AlertTriangle size={14} />
                    <span>
                      {importingArchive
                        ? (importTarget === footprintAutoCategory
                          ? <>库内还没有任何分类目录：将完全按包内最近的 <code>&lt;分类&gt;.3dshapes/</code> 目录归位并新建分类，没有该层级的条目会被跳过。深层子目录会拍平，同名文件会被覆盖。</>
                          : <>包内最近的 <code>&lt;分类&gt;.3dshapes/</code> 目录决定去向：已有分类直接归位，库内没有的分类自动新建；没有该层级的（含散装文件）写入上方所选分类。深层子目录会拍平，同名文件会被覆盖。</>)
                        : (categoryCount === 0
                          ? <>库内还没有任何分类目录，无法写入单个模型；请改用 <code>.zip</code> 压缩包做批量恢复。</>
                          : <>写入 <code>footprint/3dmodels/&lt;分类&gt;/</code>，同名文件会被覆盖。仅支持 .step / .stp / .glb 模型文件，或 .zip 压缩包。</>)}
                    </span>
                  </p>
                )}

                {importError && (
                  <p className="step-picker-import-error" role="alert">
                    <AlertTriangle size={15} />
                    <span>{importError}</span>
                  </p>
                )}
              </div>

              <footer className="step-picker-actions step-picker-import-actions">
                <button className="step-picker-cancel" onClick={resetImportPanel} type="button">
                  {importResult || importArchiveResult ? '完成' : '取消'}
                </button>
                {!importResult && !importArchiveResult && (
                  <button
                    className="step-picker-bind"
                    disabled={importState === 'uploading' || !importTarget || Boolean(importError)}
                    onClick={confirmImport}
                    type="button"
                  >
                    {importState === 'uploading'
                      ? <><LoaderCircle className="spin" size={15} /><span>正在导入</span></>
                      : <><FileUp size={15} /><span>{importingArchive ? '解压导入' : '确认导入'}</span></>}
                  </button>
                )}
              </footer>
            </section>
          </div>
        )}
      </section>
    </div>
  )
}
