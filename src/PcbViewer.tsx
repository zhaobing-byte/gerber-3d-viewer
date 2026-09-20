import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { renderSVG, renderThree } from 'web-gerber'
import type { PathSegment, SvgElement } from 'web-gerber'
import type { BomItem } from './assembly-data'
import type { FootprintModel } from './footprint-library'
import type { ParsedBoard, ParsedLayer } from './gerber'
import type { PlacementAlignment } from './placement-alignment'
import { parseStepArrayBuffer } from './step-model'

export type CameraPreset = 'iso' | 'top' | 'bottom'

export interface LayerVisibility {
  board: boolean
  copper: boolean
  mask: boolean
  silkscreen: boolean
  drill: boolean
  components: boolean
  grid: boolean
}

export interface PackageOrientation {
  rotationZ: number
  rotationX: number
  /** 沿板面 X 轴的位移（mm）。 */
  offsetX: number
  /** 沿板面 Y 轴的位移（mm）。 */
  offsetY: number
  /** 沿元件所在面法向的高度偏移（mm），正值表示远离板面。 */
  offsetZ: number
}

interface PcbViewerProps {
  board: ParsedBoard | null
  thickness: number
  boardColor: string
  visibility: LayerVisibility
  cameraPreset: CameraPreset
  cameraRevision: number
  alignment: PlacementAlignment | null
  bomItems: BomItem[]
  footprintModelOverrides: ReadonlyMap<string, FootprintModel>
  selectedDesignators: string[]
  selectionRevision: number
  bomRowOrientations: ReadonlyMap<string, PackageOrientation>
  onComponentSelect: (designator: string) => void
  /** 双击未命中元件的空白处时调用，用于解除高亮。 */
  onClearSelection: () => void
}

type LayerKind = Exclude<keyof LayerVisibility, 'grid' | 'components'>
type SurfaceSide = 'top' | 'bottom'

const copperColor = 0xd0a84f
const silkColor = 0xf0eee6
const drillColor = 0x090c0a
const substrateColor = 0xd8ad4f
const RASTER_LAYER_THRESHOLD = 500
const FOOTPRINT_MODEL_SCALE = 1000
const footprintLoader = new GLTFLoader()
const footprintTemplateCache = new Map<string, Promise<THREE.Group>>()
const boardNormal = new THREE.Vector3(0, 0, 1)
const boardTangent = new THREE.Vector3(1, 0, 0)

function requiresFlatPostureValidation(model: FootprintModel) {
  return /(?:^|_)(?:R|C|L)_?\d{4}|SOT|SOD/i.test(model.name)
}

function normalizeFootprintTemplate(
  template: THREE.Group,
  model: FootprintModel,
  isStepModel: boolean,
) {
  const correction = new THREE.Quaternion()
  if (!isStepModel) {
    template.scale.setScalar(FOOTPRINT_MODEL_SCALE)
    const gltfToBoard = new THREE.Quaternion().setFromAxisAngle(boardTangent, Math.PI / 2)
    template.quaternion.premultiply(gltfToBoard)
    correction.premultiply(gltfToBoard)
  }

  template.updateMatrixWorld(true)
  let bounds = new THREE.Box3().setFromObject(template)
  let size = bounds.getSize(new THREE.Vector3())
  if (requiresFlatPostureValidation(model)) {
    const smallestAxis = size.x <= size.y && size.x <= size.z
      ? 'x'
      : size.y <= size.z ? 'y' : 'z'
    const postureCorrection = new THREE.Quaternion()
    if (smallestAxis === 'x') {
      postureCorrection.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2)
    } else if (smallestAxis === 'y') {
      postureCorrection.setFromAxisAngle(boardTangent, Math.PI / 2)
    }
    if (smallestAxis !== 'z') {
      template.quaternion.premultiply(postureCorrection)
      correction.premultiply(postureCorrection)
      template.updateMatrixWorld(true)
      bounds = new THREE.Box3().setFromObject(template)
      size = bounds.getSize(new THREE.Vector3())
    }
  }

  const center = bounds.getCenter(new THREE.Vector3())
  template.position.x -= center.x
  template.position.y -= center.y
  template.position.z -= bounds.min.z
  template.updateMatrixWorld(true)
  bounds = new THREE.Box3().setFromObject(template)
  size = bounds.getSize(new THREE.Vector3())
  const flatPosture = !requiresFlatPostureValidation(model)
    || size.z <= Math.min(size.x, size.y) * 1.05 + 0.001
  const correctionTuple = correction.toArray() as [number, number, number, number]
  model.modelCorrectionQuaternion = correctionTuple
  template.userData.modelCorrectionQuaternion = correctionTuple
  template.userData.flatPosture = flatPosture
  template.userData.normalizedModelSize = size.toArray()
  template.userData.modelNormalized = true
}

function loadFootprintTemplate(model: FootprintModel): Promise<THREE.Group> {
  const cacheKey = model.stepUrl ?? model.url
  const cached = footprintTemplateCache.get(cacheKey)
  if (cached) return cached

  const request = (model.stepUrl
    ? fetch(model.stepUrl).then(async (response) => {
        if (!response.ok) throw new Error(`STEP HTTP ${response.status}`)
        const template = await parseStepArrayBuffer(await response.arrayBuffer(), model.name)
        template.userData.stepModel = true
        return template
      })
    : footprintLoader.loadAsync(model.url).then((gltf) => gltf.scene)
  ).then((template) => {
    normalizeFootprintTemplate(template, model, Boolean(model.stepUrl))
    template.name = `footprint-template:${model.name}`
    template.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.sharedFootprintResource = true
    })
    return template
  })
  footprintTemplateCache.set(cacheKey, request)
  return request
}

function cloneFootprintTemplate(template: THREE.Group): THREE.Group {
  const instance = template.clone(true)
  instance.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.sharedFootprintResource = true
  })
  return instance
}

function replaceMaterial(
  object: THREE.Object3D,
  color: THREE.ColorRepresentation,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    if (mesh.userData.keepMaterial) return
    mesh.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.58,
      metalness: 0.05,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      ...options,
    })
    mesh.castShadow = true
    mesh.receiveShadow = true
  })
}

function setKind(object: THREE.Object3D, kind: LayerKind) {
  object.userData.layerKind = kind
  return object
}

function setSurfaceSide(object: THREE.Object3D, side: SurfaceSide) {
  object.userData.surfaceSide = side
  return object
}

function applyBoardVisibility(
  root: THREE.Group,
  visibility: LayerVisibility,
  cameraZ: number,
) {
  const visibleSide: SurfaceSide = cameraZ >= 0 ? 'top' : 'bottom'
  for (const child of root.children) {
    const kind = child.userData.layerKind as LayerKind | undefined
    if (!kind) continue
    const surfaceSide = child.userData.surfaceSide as SurfaceSide | undefined
    const facesCamera = !surfaceSide || surfaceSide === visibleSide
    child.visible = visibility[kind]
      && facesCamera
      && (!child.userData.underMask || !visibility.mask)
  }
}

function applyComponentVisibility(root: THREE.Group, visible: boolean, cameraZ: number) {
  const visibleSide: SurfaceSide = cameraZ >= 0 ? 'top' : 'bottom'
  root.children.forEach((child) => {
    const surfaceSide = child.userData.surfaceSide as SurfaceSide | undefined
    child.visible = visible && (!surfaceSide || surfaceSide === visibleSide)
  })
}

const componentHighlightColor = new THREE.Color(0x00e5ff)

function highlightFootprintInstance(instance: THREE.Object3D) {
  instance.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return

    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const highlightedMaterials = sourceMaterials.map((sourceMaterial) => {
      const material = sourceMaterial.clone() as THREE.Material & {
        color?: THREE.Color
        emissive?: THREE.Color
        emissiveIntensity?: number
      }
      material.color?.lerp(componentHighlightColor, 0.25)
      if (material.emissive) {
        material.emissive.copy(componentHighlightColor)
        material.emissiveIntensity = 0.2
      }
      material.depthTest = true
      material.depthWrite = true
      material.needsUpdate = true
      return material
    })

    mesh.material = Array.isArray(mesh.material) ? highlightedMaterials : highlightedMaterials[0]
    mesh.userData.instanceHighlightMaterial = true
  })
}

function findModelOrientationRoot(marker: THREE.Object3D): THREE.Group | undefined {
  let result: THREE.Group | undefined
  marker.traverse((child) => {
    if (!result && child.userData.modelOrientationRoot) result = child as THREE.Group
  })
  return result
}

function createPlacementObject(
  board: ParsedBoard,
  thickness: number,
  alignment: PlacementAlignment,
  bomItems: BomItem[],
  footprintModelOverrides: ReadonlyMap<string, FootprintModel>,
  selectedDesignators: string[],
  getBomRowOrientation: (bomItemId: string) => PackageOrientation | undefined,
  onModelProgress: () => void,
): THREE.Group {
  const root = new THREE.Group()
  const [x1, y1, x2, y2] = board.boundsMm
  root.name = 'placement-root'
  root.position.set(-(x1 + x2) / 2, -(y1 + y2) / 2, 0)
  root.userData.alignmentMode = alignment.mode
  root.userData.insideCount = alignment.insideCount
  root.userData.placementCount = alignment.totalCount
  root.userData.modelMatchedCount = 0
  root.userData.modelLoadedCount = 0
  root.userData.modelFailedCount = 0
  root.userData.postureValidCount = 0
  root.userData.postureInvalidDesignators = [] as string[]
  root.userData.contactValidCount = 0
  root.userData.contactInvalidDesignators = [] as string[]
  root.userData.disposed = false
  root.userData.outsideDesignators = alignment.placements
    .filter((placement) => !placement.isInsideBoard)
    .map((placement) => placement.designator)
    .join(',')

  const itemByDesignator = new Map<string, BomItem>()
  bomItems.forEach((item) => item.designators.forEach((designator) => {
    itemByDesignator.set(designator.trim().toUpperCase(), item)
  }))
  const selected = new Set(selectedDesignators.map((designator) => designator.trim().toUpperCase()))

  alignment.placements.forEach((placement) => {
    const designator = placement.designator.trim().toUpperCase()
    const item = itemByDesignator.get(designator)
    if (!item) return
    // App 只把已完成数据库核对、且已自动或人工绑定模型的 BOM 行传进来。
    // 这里不再按裸封装名兜底，避免未经金蝶确认的元件出现在 PCB 上。
    const model = footprintModelOverrides.get(item.id)
    if (!model) return
    const isSelected = selected.has(designator)
    const side: SurfaceSide = placement.side === 'bottom' ? 'bottom' : 'top'

    const marker = new THREE.Group()
    const sideRoot = new THREE.Group()
    const inPlaneRoot = new THREE.Group()
    const modelRoot = new THREE.Group()
    const surfaceOffset = thickness / 2 + 0.09
    // 记下基准位置：位移是相对基准的绝对量，反复调整不会累积漂移。
    marker.userData.basePosition = {
      x: placement.boardXmm,
      y: placement.boardYmm,
      z: side === 'bottom' ? -surfaceOffset : surfaceOffset,
    }
    marker.position.set(
      placement.boardXmm,
      placement.boardYmm,
      side === 'bottom' ? -surfaceOffset : surfaceOffset,
    )
    marker.userData.baseRotation = placement.rotation
    marker.userData.bomItemId = item.id
    marker.userData.surfaceSide = side
    marker.userData.designator = designator
    marker.userData.selected = isSelected
    marker.userData.placementMarker = true
    sideRoot.quaternion.setFromAxisAngle(boardTangent, side === 'bottom' ? Math.PI : 0)
    sideRoot.userData.componentSurfaceRoot = true
    inPlaneRoot.userData.componentRotationRoot = true
    modelRoot.userData.modelOrientationRoot = true
    inPlaneRoot.add(modelRoot)
    sideRoot.add(inPlaneRoot)
    marker.add(sideRoot)
    root.add(marker)

    applyPlacementOrientation(marker, getBomRowOrientation(item.id))

    root.userData.modelMatchedCount += 1
    void loadFootprintTemplate(model).then((template) => {
      if (root.userData.disposed) return

      const instance = cloneFootprintTemplate(template)
      instance.name = `footprint:${model.name}:${designator}`
      if (isSelected) highlightFootprintInstance(instance)
      instance.updateMatrixWorld(true)

      const bounds = new THREE.Box3().setFromObject(instance)
      const size = bounds.getSize(new THREE.Vector3())
      const largestDimension = Math.max(size.x, size.y, size.z)
      if (!Number.isFinite(largestDimension) || largestDimension < 0.05 || largestDimension > 100) {
        throw new Error(`模型尺寸异常: ${largestDimension.toFixed(3)} mm`)
      }

      modelRoot.add(instance)
      applyPlacementOrientation(marker, getBomRowOrientation(item.id))
      const postureValid = Boolean(template.userData.flatPosture)
      marker.userData.postureValid = postureValid
      marker.userData.modelCorrectionQuaternion = template.userData.modelCorrectionQuaternion
      if (postureValid) root.userData.postureValidCount += 1
      else (root.userData.postureInvalidDesignators as string[]).push(designator)
      root.updateWorldMatrix(true, true)
      const placedBounds = new THREE.Box3().setFromObject(modelRoot)
      const contactGap = side === 'bottom'
        ? -thickness / 2 - placedBounds.max.z
        : placedBounds.min.z - thickness / 2
      const contactValid = contactGap >= -0.01 && contactGap <= 0.2
      marker.userData.contactGap = contactGap
      marker.userData.contactValid = contactValid
      if (contactValid) root.userData.contactValidCount += 1
      else (root.userData.contactInvalidDesignators as string[]).push(designator)
      marker.userData.modelLoaded = true
      root.userData.modelLoadedCount += 1
      onModelProgress()
    }).catch((error: unknown) => {
      if (root.userData.disposed) return
      root.userData.modelFailedCount += 1
      marker.userData.modelError = error instanceof Error ? error.message : String(error)
      onModelProgress()
    })
  })

  return root
}

function applyPlacementOrientation(marker: THREE.Object3D, orientation?: PackageOrientation) {
  const baseRotation = marker.userData.baseRotation
  if (typeof baseRotation !== 'number') return
  const rotationZ = orientation?.rotationZ ?? 0
  const rotationX = orientation?.rotationX ?? 0
  const offsetX = orientation?.offsetX ?? 0
  const offsetY = orientation?.offsetY ?? 0
  const offsetZ = orientation?.offsetZ ?? 0
  marker.userData.appliedRotationZ = rotationZ
  marker.userData.appliedRotationX = rotationX
  marker.userData.appliedOffsetX = offsetX
  marker.userData.appliedOffsetY = offsetY
  marker.userData.appliedOffsetZ = offsetZ
  marker.userData.appliedPlacementRotation = (baseRotation + rotationZ) % 360

  const basePosition = marker.userData.basePosition as { x: number; y: number; z: number } | undefined
  if (basePosition) {
    // 底面元件的外法向是 -Z，取反后「高度+」在两个面上都是远离板面。
    const heightSign = marker.userData.surfaceSide === 'bottom' ? -1 : 1
    marker.position.set(
      basePosition.x + offsetX,
      basePosition.y + offsetY,
      basePosition.z + offsetZ * heightSign,
    )
  }

  const sideRoot = marker.children.find((child) => child.userData.componentSurfaceRoot) as THREE.Group | undefined
  const inPlaneRoot = sideRoot?.children.find((child) => child.userData.componentRotationRoot) as THREE.Group | undefined
  const modelRoot = findModelOrientationRoot(marker)
  if (!sideRoot || !inPlaneRoot || !modelRoot) return

  inPlaneRoot.quaternion.setFromAxisAngle(boardNormal, THREE.MathUtils.degToRad(baseRotation + rotationZ))
  modelRoot.quaternion.setFromAxisAngle(boardTangent, THREE.MathUtils.degToRad(rotationX))
  modelRoot.position.z = 0
  if (modelRoot.children.length === 0) return

  inPlaneRoot.remove(modelRoot)
  modelRoot.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(modelRoot)
  modelRoot.position.z = Number.isFinite(bounds.min.z) ? -bounds.min.z : 0
  inPlaneRoot.add(modelRoot)
}

function applyBomRowOrientations(
  root: THREE.Group,
  bomRowOrientations: ReadonlyMap<string, PackageOrientation>,
) {
  root.children.forEach((child) => {
    const bomItemId = child.userData.bomItemId
    const baseRotation = child.userData.baseRotation
    if (typeof bomItemId !== 'string' || typeof baseRotation !== 'number') return
    applyPlacementOrientation(child, bomRowOrientations.get(bomItemId))
  })
}

interface SelectionCameraFocus {
  bounds: THREE.Box3
  target: THREE.Vector3
  position: THREE.Vector3
  distance: number
  matchedCount: number
  screenCoverage: number
  components: SelectedComponentBounds[]
}

interface SelectedComponentBounds {
  marker: THREE.Object3D
  designator: string
  bounds: THREE.Box3
}

interface ProjectedSelectionRange {
  fits: boolean
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface SelectionOverlayItem {
  element: HTMLDivElement
  ring: HTMLSpanElement
  leader: HTMLSpanElement
  label: HTMLSpanElement
  bounds: THREE.Box3
  designator: string
}

const selectionViewportMargin = 0.08
const selectionFocusDurationMs = 300
const minimumSelectionDistance = 12
const singleSelectionMaximumCoverage = 0.18

function appendTransformedBoxCorners(
  box: THREE.Box3,
  matrix: THREE.Matrix4,
  points: THREE.Vector3[],
  bounds: THREE.Box3,
) {
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const point = new THREE.Vector3(x, y, z).applyMatrix4(matrix)
        points.push(point)
        bounds.expandByPoint(point)
      }
    }
  }
}

function collectSelectedComponentBounds(root: THREE.Group) {
  root.updateWorldMatrix(true, true)
  const allPoints: THREE.Vector3[] = []
  const components: SelectedComponentBounds[] = []
  const instanceMatrix = new THREE.Matrix4()
  const instanceWorldMatrix = new THREE.Matrix4()

  root.children.forEach((marker) => {
    if (!marker.userData.selected) return
    const modelRoot = findModelOrientationRoot(marker)
    if (!modelRoot) return

    const points: THREE.Vector3[] = []
    const bounds = new THREE.Box3()
    modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      const geometryBounds = mesh.geometry.boundingBox
      if (!geometryBounds || geometryBounds.isEmpty()) return

      const instancedMesh = mesh as THREE.InstancedMesh
      if (instancedMesh.isInstancedMesh) {
        for (let index = 0; index < instancedMesh.count; index += 1) {
          instancedMesh.getMatrixAt(index, instanceMatrix)
          instanceWorldMatrix.multiplyMatrices(instancedMesh.matrixWorld, instanceMatrix)
          appendTransformedBoxCorners(geometryBounds, instanceWorldMatrix, points, bounds)
        }
      } else {
        appendTransformedBoxCorners(geometryBounds, mesh.matrixWorld, points, bounds)
      }
    })
    if (bounds.isEmpty()) return

    allPoints.push(...points)
    components.push({
      marker,
      designator: String(marker.userData.designator ?? ''),
      bounds,
    })
  })

  return { allPoints, components }
}

function calculateSelectionCameraFocus(
  root: THREE.Group,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  canvas: HTMLCanvasElement,
): SelectionCameraFocus | null {
  const { allPoints, components } = collectSelectedComponentBounds(root)
  if (components.length === 0 || allPoints.length === 0) return null
  const bounds = new THREE.Box3()
  allPoints.forEach((point) => bounds.expandByPoint(point))
  if (bounds.isEmpty()) return null

  const center = bounds.getCenter(new THREE.Vector3())
  const viewDirection = camera.position.clone().sub(controls.target)
  if (viewDirection.lengthSq() < 0.0001) viewDirection.set(0.76, -1, 0.82)
  viewDirection.normalize()
  const canvasWidth = Math.max(canvas.clientWidth, 1)
  const canvasHeight = Math.max(canvas.clientHeight, 1)
  const fitCamera = camera.clone() as THREE.PerspectiveCamera
  fitCamera.aspect = canvasWidth / canvasHeight
  fitCamera.near = 0.001
  fitCamera.far = 1_000_000
  fitCamera.up.copy(camera.up)
  fitCamera.updateProjectionMatrix()
  const projected = new THREE.Vector3()
  const cameraSpace = new THREE.Vector3()
  const safeNdc = 1 - selectionViewportMargin * 2
  const projectAtDistance = (distance: number): ProjectedSelectionRange => {
    fitCamera.position.copy(center).addScaledVector(viewDirection, distance)
    fitCamera.lookAt(center)
    fitCamera.updateMatrixWorld(true)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    let allInFront = true
    allPoints.forEach((point) => {
      cameraSpace.copy(point).applyMatrix4(fitCamera.matrixWorldInverse)
      if (cameraSpace.z >= -fitCamera.near) allInFront = false
      projected.copy(point).project(fitCamera)
      minX = Math.min(minX, projected.x)
      maxX = Math.max(maxX, projected.x)
      minY = Math.min(minY, projected.y)
      maxY = Math.max(maxY, projected.y)
    })
    return {
      fits: allInFront
        && minX >= -safeNdc
        && maxX <= safeNdc
        && minY >= -safeNdc
        && maxY <= safeNdc,
      minX,
      maxX,
      minY,
      maxY,
    }
  }

  const minimumDistance = Math.max(controls.minDistance, minimumSelectionDistance)
  let lowerDistance = minimumDistance
  let upperDistance = minimumDistance
  let upperRange = projectAtDistance(upperDistance)
  while (!upperRange.fits && upperDistance < controls.maxDistance) {
    lowerDistance = upperDistance
    upperDistance = Math.min(upperDistance * 2, controls.maxDistance)
    upperRange = projectAtDistance(upperDistance)
  }
  if (!upperRange.fits) return null

  if (projectAtDistance(minimumDistance).fits) {
    lowerDistance = minimumDistance
    upperDistance = minimumDistance
  } else {
    for (let iteration = 0; iteration < 36; iteration += 1) {
      const distance = (lowerDistance + upperDistance) / 2
      if (projectAtDistance(distance).fits) upperDistance = distance
      else lowerDistance = distance
    }
  }
  const coverageOf = (range: ProjectedSelectionRange) => Math.max(
    (range.maxX - range.minX) / 2,
    (range.maxY - range.minY) / 2,
  )
  let distance = upperDistance
  let finalRange = projectAtDistance(distance)
  let screenCoverage = coverageOf(finalRange)
  if (components.length === 1 && screenCoverage > singleSelectionMaximumCoverage) {
    let nearDistance = distance
    let farDistance = distance
    let farRange = finalRange
    while (coverageOf(farRange) > singleSelectionMaximumCoverage && farDistance < controls.maxDistance) {
      nearDistance = farDistance
      farDistance = Math.min(farDistance * 2, controls.maxDistance)
      farRange = projectAtDistance(farDistance)
    }
    for (let iteration = 0; iteration < 36; iteration += 1) {
      const candidateDistance = (nearDistance + farDistance) / 2
      const candidateRange = projectAtDistance(candidateDistance)
      if (coverageOf(candidateRange) <= singleSelectionMaximumCoverage) farDistance = candidateDistance
      else nearDistance = candidateDistance
    }
    distance = farDistance
    finalRange = projectAtDistance(distance)
    screenCoverage = coverageOf(finalRange)
  }

  return {
    bounds,
    target: center,
    position: center.clone().addScaledVector(viewDirection, distance),
    distance,
    matchedCount: components.length,
    screenCoverage,
    components,
  }
}

function createFallbackBoard(board: ParsedBoard, thickness: number): THREE.Group {
  const [x1, y1, x2, y2] = board.boundsMm
  const radius = Math.min(1.5, (x2 - x1) * 0.03, (y2 - y1) * 0.03)
  const shape = new THREE.Shape()
  shape.moveTo(x1 + radius, y1)
  shape.lineTo(x2 - radius, y1)
  shape.quadraticCurveTo(x2, y1, x2, y1 + radius)
  shape.lineTo(x2, y2 - radius)
  shape.quadraticCurveTo(x2, y2, x2 - radius, y2)
  shape.lineTo(x1 + radius, y2)
  shape.quadraticCurveTo(x1, y2, x1, y2 - radius)
  shape.lineTo(x1, y1 + radius)
  shape.quadraticCurveTo(x1, y1, x1 + radius, y1)

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    bevelEnabled: true,
    bevelSize: 0.12,
    bevelThickness: 0.08,
    bevelSegments: 2,
  })
  geometry.translate(0, 0, -0.5)
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geometry))
  return group
}

interface SvgNodeLike {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: SvgNodeLike[]
  value?: string
}

function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function svgAttributeName(name: string): string {
  if (name === 'xmlnsXLink') return 'xmlns:xlink'
  if (name === 'viewBox' || name === 'preserveAspectRatio') return name
  if (name === 'className') return 'class'
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function serializeSvgNode(node: SvgNodeLike): string {
  if (node.type === 'text') return escapeXml(node.value ?? '')
  if (node.type !== 'element' || !node.tagName) return ''
  const attributes = Object.entries(node.properties ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([name, value]) => {
      const normalized = Array.isArray(value) ? value.join(' ') : value === true ? '' : value
      return normalized === ''
        ? ` ${svgAttributeName(name)}`
        : ` ${svgAttributeName(name)}="${escapeXml(normalized)}"`
    })
    .join('')
  const children = (node.children ?? []).map(serializeSvgNode).join('')
  return `<${node.tagName}${attributes}>${children}</${node.tagName}>`
}

function textureDimensions(board: ParsedBoard, maxTextureSize: number): [number, number] {
  const pixelsPerMm = 32
  const targetWidth = Math.max(board.widthMm * pixelsPerMm, 512)
  const targetHeight = Math.max(board.heightMm * pixelsPerMm, 512)
  const textureLimit = Math.min(maxTextureSize, 4096)
  const scale = Math.min(1, textureLimit / Math.max(targetWidth, targetHeight))
  return [Math.round(targetWidth * scale), Math.round(targetHeight * scale)]
}

function createLayerTexture(
  board: ParsedBoard,
  layer: ParsedLayer,
  color: THREE.ColorRepresentation,
  maxAnisotropy: number,
  maxTextureSize: number,
  onLoad: () => void,
): THREE.Texture {
  const [x1, y1, x2, y2] = board.boundsMm
  const viewBox: [number, number, number, number] = [
    x1 / layer.unitScale,
    -y2 / layer.unitScale,
    (x2 - x1) / layer.unitScale,
    (y2 - y1) / layer.unitScale,
  ]
  const tree = renderSVG(layer.image, viewBox) as SvgElement & { properties: Record<string, unknown> }
  const [width, height] = textureDimensions(board, maxTextureSize)
  tree.properties = {
    ...tree.properties,
    color: `#${new THREE.Color(color).getHexString()}`,
    width,
    height,
    preserveAspectRatio: 'none',
  }

  const svg = serializeSvgNode(tree as unknown as SvgNodeLike)
  const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  const image = new Image()
  image.decoding = 'async'
  const texture = new THREE.Texture(image)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = maxAnisotropy
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  image.addEventListener('load', () => {
    texture.needsUpdate = true
    URL.revokeObjectURL(objectUrl)
    onLoad()
  }, { once: true })
  image.addEventListener('error', () => {
    URL.revokeObjectURL(objectUrl)
    console.warn(`Unable to rasterize ${layer.name}`)
  }, { once: true })
  image.src = objectUrl
  return texture
}

function createRasterizedLayers(
  board: ParsedBoard,
  layers: ParsedLayer[],
  color: THREE.ColorRepresentation,
  z: number,
  depth: number,
  maxAnisotropy: number,
  maxTextureSize: number,
  onTextureLoad: () => void,
): THREE.Group {
  const group = new THREE.Group()
  const [x1, y1, x2, y2] = board.boundsMm
  const geometry = new THREE.PlaneGeometry(board.widthMm, board.heightMm)
  const zPositions = z === 0 ? [depth / 2, -depth / 2] : [z]

  layers.forEach((layer, layerIndex) => {
    const texture = createLayerTexture(
      board,
      layer,
      color,
      maxAnisotropy,
      maxTextureSize,
      onTextureLoad,
    )
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      alphaTest: 0.02,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
      transparent: true,
    })
    zPositions.forEach((surfaceZ) => {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(
        (x1 + x2) / 2,
        (y1 + y2) / 2,
        surfaceZ + Math.sign(surfaceZ || 1) * layerIndex * 0.0005,
      )
      mesh.renderOrder = 3
      mesh.userData.keepMaterial = true
      group.add(mesh)
    })
  })
  return group
}

interface DirectedSegment {
  segment: PathSegment
  reversed: boolean
}

interface ProfileContour {
  points: THREE.Vector2[]
  area: number
  parent: number | null
  depth: number
}

function segmentPoint(segment: DirectedSegment, start: boolean): THREE.Vector2 {
  const useStart = start !== segment.reversed
  const position = useStart ? segment.segment.start : segment.segment.end
  return new THREE.Vector2(position[0], position[1])
}

function pointsMeet(left: THREE.Vector2, right: THREE.Vector2, tolerance: number): boolean {
  return left.distanceToSquared(right) <= tolerance * tolerance
}

function collectProfileSegments(layer: ParsedLayer): PathSegment[] {
  const segments: PathSegment[] = []
  for (const child of layer.image.children) {
    if (child.type === 'imagePath' || child.type === 'imageRegion') {
      segments.push(...child.segments)
    } else if (child.type === 'imageShape' && child.shape.type === 'outline') {
      segments.push(...child.shape.segments)
    }
  }
  return segments.filter((segment) => (
    Number.isFinite(segment.start[0])
    && Number.isFinite(segment.start[1])
    && Number.isFinite(segment.end[0])
    && Number.isFinite(segment.end[1])
  ))
}

function connectProfileSegments(layer: ParsedLayer): DirectedSegment[][] {
  const tolerance = 0.02 / layer.unitScale
  const pending = collectProfileSegments(layer).map((segment) => ({ segment, reversed: false }))
  const contours: DirectedSegment[][] = []

  while (pending.length > 0) {
    const chain = [pending.shift()!]
    const firstPoint = segmentPoint(chain[0], true)
    let endPoint = segmentPoint(chain[0], false)

    while (!pointsMeet(firstPoint, endPoint, tolerance) && pending.length > 0) {
      const matchIndex = pending.findIndex((candidate) => (
        pointsMeet(segmentPoint(candidate, true), endPoint, tolerance)
        || pointsMeet(segmentPoint(candidate, false), endPoint, tolerance)
      ))
      if (matchIndex < 0) break

      const next = pending.splice(matchIndex, 1)[0]
      if (!pointsMeet(segmentPoint(next, true), endPoint, tolerance)) next.reversed = true
      chain.push(next)
      endPoint = segmentPoint(next, false)
    }

    if (pointsMeet(firstPoint, endPoint, tolerance)) contours.push(chain)
  }

  return contours
}

function sampleSegment(directed: DirectedSegment, unitScale: number): THREE.Vector2[] {
  const { segment, reversed } = directed
  const endPoint = segmentPoint(directed, false)
  if (segment.type === 'line') return [endPoint]

  const startAngle = reversed ? segment.end[2] : segment.start[2]
  const endAngle = reversed ? segment.start[2] : segment.end[2]
  const clockwise = reversed ? segment.start[2] <= segment.end[2] : segment.start[2] > segment.end[2]
  const fullCircle = Math.abs(startAngle - endAngle) < 1e-8
  let sweep = Math.abs(endAngle - startAngle)
  if (fullCircle) sweep = Math.PI * 2
  else if (sweep > Math.PI * 2) sweep %= Math.PI * 2
  const arcLengthMm = Math.max(segment.radius * sweep * unitScale, 0.1)
  const divisions = THREE.MathUtils.clamp(Math.ceil(arcLengthMm / 0.35), 8, 160)
  const curve = new THREE.EllipseCurve(
    segment.center[0],
    segment.center[1],
    segment.radius,
    segment.radius,
    startAngle,
    endAngle,
    clockwise,
  )
  const points = curve.getPoints(divisions).slice(1)
  points[points.length - 1] = endPoint
  return points
}

function polygonArea(points: THREE.Vector2[]): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

function pointInPolygon(point: THREE.Vector2, polygon: THREE.Vector2[]): boolean {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current]
    const b = polygon[previous]
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function interiorPoint(points: THREE.Vector2[]): THREE.Vector2 {
  const triangles = THREE.ShapeUtils.triangulateShape(points, [])
  const triangle = triangles[0]
  if (triangle) {
    return points[triangle[0]].clone()
      .add(points[triangle[1]])
      .add(points[triangle[2]])
      .multiplyScalar(1 / 3)
  }
  return points.reduce((sum, point) => sum.add(point), new THREE.Vector2()).multiplyScalar(1 / points.length)
}

function buildProfileContours(layer: ParsedLayer): ProfileContour[] {
  const minimumArea = 0.01 / (layer.unitScale * layer.unitScale)
  const contours: ProfileContour[] = connectProfileSegments(layer).flatMap((chain): ProfileContour[] => {
    const points = [segmentPoint(chain[0], true)]
    for (const segment of chain) points.push(...sampleSegment(segment, layer.unitScale))
    if (pointsMeet(points[0], points[points.length - 1], 0.02 / layer.unitScale)) points.pop()

    const compact = points.filter((point, index) => (
      index === 0 || !pointsMeet(point, points[index - 1], 1e-7)
    ))
    const area = polygonArea(compact)
    return compact.length >= 3 && Math.abs(area) >= minimumArea
      ? [{ points: compact, area: Math.abs(area), parent: null, depth: 0 }]
      : []
  })

  const interiorPoints = contours.map((contour) => interiorPoint(contour.points))
  for (let index = 0; index < contours.length; index += 1) {
    let parent: number | null = null
    for (let candidate = 0; candidate < contours.length; candidate += 1) {
      if (candidate === index || contours[candidate].area <= contours[index].area) continue
      if (!pointInPolygon(interiorPoints[index], contours[candidate].points)) continue
      if (parent === null || contours[candidate].area < contours[parent].area) parent = candidate
    }
    contours[index].parent = parent
  }

  const resolveDepth = (index: number, seen = new Set<number>()): number => {
    if (seen.has(index)) return 0
    const parent = contours[index].parent
    if (parent === null) return 0
    seen.add(index)
    return resolveDepth(parent, seen) + 1
  }
  contours.forEach((contour, index) => {
    contour.depth = resolveDepth(index)
  })
  return contours
}

function normalizeWinding(points: THREE.Vector2[], clockwise: boolean): THREE.Vector2[] {
  const copy = points.map((point) => point.clone())
  return THREE.ShapeUtils.isClockWise(copy) === clockwise ? copy : copy.reverse()
}

function createProfileBoard(layer: ParsedLayer): THREE.Group | null {
  const contours = buildProfileContours(layer)
  const shapes: THREE.Shape[] = []

  contours.forEach((contour, index) => {
    if (contour.depth % 2 !== 0) return
    const shape = new THREE.Shape(normalizeWinding(contour.points, true))
    contours.forEach((hole, holeIndex) => {
      if (holeIndex === index || hole.parent !== index || hole.depth !== contour.depth + 1) return
      shape.holes.push(new THREE.Path(normalizeWinding(hole.points, false)))
    })
    shapes.push(shape)
  })

  if (shapes.length === 0) return null
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: 1,
    bevelEnabled: false,
    curveSegments: 8,
  })
  geometry.translate(0, 0, -0.5)
  geometry.computeVertexNormals()

  const capGeometry = new THREE.ShapeGeometry(shapes, 8)
  const topCap = new THREE.Mesh(capGeometry)
  topCap.position.z = 0.5002
  const bottomCap = new THREE.Mesh(capGeometry.clone())
  bottomCap.position.z = -0.5002

  const group = new THREE.Group()
  group.scale.set(layer.unitScale, layer.unitScale, 1)
  group.userData.profileContours = contours.length
  group.userData.profileSolids = shapes.length
  group.add(new THREE.Mesh(geometry), topCap, bottomCap)
  return group
}

function renderGerberLayer(layer: ParsedLayer, color: number, outline = false): THREE.Group | null {
  try {
    const object = renderThree(layer.image, color, undefined, outline)
    object.scale.x = layer.unitScale
    object.scale.y = layer.unitScale
    return object
  } catch (error) {
    console.warn(`Unable to render ${layer.name}`, error)
    return null
  }
}

function mergeRenderedLayers(layers: ParsedLayer[], color: number): THREE.Group {
  const group = new THREE.Group()
  for (const layer of layers) {
    const rendered = renderGerberLayer(layer, color)
    if (rendered) group.add(rendered)
  }
  return group
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    if (mesh.userData.sharedFootprintResource) {
      if (mesh.userData.instanceHighlightMaterial) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.forEach((material) => material.dispose())
      }
      return
    }
    mesh.geometry.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => {
      const mappedMaterial = material as THREE.Material & { map?: THREE.Texture | null }
      mappedMaterial.map?.dispose()
      material.dispose()
    })
  })
}

function buildBoardObject(
  board: ParsedBoard,
  thickness: number,
  maskColor: string,
  maxAnisotropy: number,
  maxTextureSize: number,
  onTextureLoad: () => void,
): THREE.Group {
  const root = new THREE.Group()
  root.name = 'pcb-root'
  const [x1, y1, x2, y2] = board.boundsMm
  root.position.set(-(x1 + x2) / 2, -(y1 + y2) / 2, 0)

  const outlineLayer = board.layers.find((layer) => layer.id === board.profileLayerId)
  let body = outlineLayer ? createProfileBoard(outlineLayer) : null
  if (!body || body.children.length === 0) body = createFallbackBoard(board, thickness)
  body.scale.z = thickness
  replaceMaterial(body, substrateColor, {
    depthWrite: true,
    metalness: 0,
    opacity: 1,
    roughness: 0.68,
    transparent: false,
  })
  setKind(body, 'board')
  root.add(body)

  const topMaskBody = body.clone(true)
  topMaskBody.scale.z = 0.018
  topMaskBody.position.z = thickness / 2 + 0.012
  replaceMaterial(topMaskBody, maskColor, {
    depthWrite: true,
    emissive: maskColor,
    emissiveIntensity: 0.12,
    metalness: 0,
    opacity: 1,
    roughness: 0.42,
    transparent: false,
  })
  setSurfaceSide(topMaskBody, 'top')
  setKind(topMaskBody, 'mask')
  root.add(topMaskBody)

  const bottomMaskBody = body.clone(true)
  bottomMaskBody.scale.z = 0.018
  bottomMaskBody.position.z = -thickness / 2 - 0.012
  replaceMaterial(bottomMaskBody, maskColor, {
    depthWrite: true,
    emissive: maskColor,
    emissiveIntensity: 0.12,
    metalness: 0,
    opacity: 1,
    roughness: 0.42,
    transparent: false,
  })
  setSurfaceSide(bottomMaskBody, 'bottom')
  setKind(bottomMaskBody, 'mask')
  root.add(bottomMaskBody)

  const byRole = (type: string, side?: string) =>
    board.layers.filter((layer) => layer.type === type && (!side || layer.side === side))

  const addSurface = (
    layers: ParsedLayer[],
    kind: LayerKind,
    color: number,
    z: number,
    depth: number,
    material: Partial<THREE.MeshStandardMaterialParameters> = {},
    underMask = false,
  ) => {
    if (layers.length === 0) return
    const rasterize = kind === 'drill'
      && layers.reduce((sum, layer) => sum + layer.image.children.length, 0) > RASTER_LAYER_THRESHOLD
    const object = rasterize
      ? createRasterizedLayers(
          board,
          layers,
          color,
          z,
          depth,
          maxAnisotropy,
          maxTextureSize,
          onTextureLoad,
        )
      : mergeRenderedLayers(layers, color)
    if (!rasterize) {
      object.scale.z = depth
      object.position.z = z
      replaceMaterial(object, color, material)
    }
    object.userData.underMask = underMask
    const surfaceSide = layers[0]?.side
    if (surfaceSide === 'top' || surfaceSide === 'bottom') setSurfaceSide(object, surfaceSide)
    setKind(object, kind)
    root.add(object)
  }

  const topMaskLayers = byRole('soldermask', 'top')
  const bottomMaskLayers = byRole('soldermask', 'bottom')

  addSurface(byRole('copper', 'top'), 'copper', copperColor, thickness / 2 + 0.031, 0.035, {
    roughness: 0.32,
    metalness: 0.62,
  }, topMaskLayers.length > 0)
  addSurface(byRole('copper', 'bottom'), 'copper', copperColor, -thickness / 2 - 0.031, 0.035, {
    roughness: 0.32,
    metalness: 0.62,
  }, bottomMaskLayers.length > 0)
  addSurface(topMaskLayers, 'copper', copperColor, thickness / 2 + 0.057, 0.014, {
    roughness: 0.3,
    metalness: 0.5,
  })
  addSurface(bottomMaskLayers, 'copper', copperColor, -thickness / 2 - 0.057, 0.014, {
    roughness: 0.3,
    metalness: 0.5,
  })
  addSurface(byRole('silkscreen', 'top'), 'silkscreen', silkColor, thickness / 2 + 0.071, 0.018, {
    roughness: 0.78,
    metalness: 0,
  })
  addSurface(byRole('silkscreen', 'bottom'), 'silkscreen', silkColor, -thickness / 2 - 0.071, 0.018, {
    roughness: 0.78,
    metalness: 0,
  })
  addSurface(byRole('drill'), 'drill', drillColor, 0, thickness + 0.22, {
    roughness: 1,
    metalness: 0,
  })

  return root
}

export default function PcbViewer({
  board,
  thickness,
  boardColor,
  visibility,
  cameraPreset,
  cameraRevision,
  alignment,
  bomItems,
  footprintModelOverrides,
  selectedDesignators,
  selectionRevision,
  bomRowOrientations,
  onComponentSelect,
  onClearSelection,
}: PcbViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const outlinePassRef = useRef<OutlinePass | null>(null)
  const innerOutlinePassRef = useRef<OutlinePass | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const boardRootRef = useRef<THREE.Group | null>(null)
  const componentRootRef = useRef<THREE.Group | null>(null)
  const gridRef = useRef<THREE.GridHelper | null>(null)
  const animationRef = useRef<number | null>(null)
  const cameraFocusAnimationRef = useRef<number | null>(null)
  const selectionOverlayRef = useRef<HTMLDivElement>(null)
  const selectionOverlayItemsRef = useRef<SelectionOverlayItem[]>([])
  const hoveredDesignatorRef = useRef<string | null>(null)
  const pixelCheckRequestedRef = useRef(true)
  const visibilityRef = useRef(visibility)
  const bomRowOrientationsRef = useRef(bomRowOrientations)
  const onComponentSelectRef = useRef(onComponentSelect)
  const onClearSelectionRef = useRef(onClearSelection)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null)
  const [viewportRevision, setViewportRevision] = useState(0)

  const cancelCameraFocusAnimation = () => {
    if (cameraFocusAnimationRef.current === null) return
    cancelAnimationFrame(cameraFocusAnimationRef.current)
    cameraFocusAnimationRef.current = null
  }

  const clearSelectionEffects = () => {
    if (outlinePassRef.current) outlinePassRef.current.selectedObjects = []
    if (innerOutlinePassRef.current) innerOutlinePassRef.current.selectedObjects = []
    selectionOverlayItemsRef.current = []
    selectionOverlayRef.current?.replaceChildren()
  }

  const showSelectionEffects = (components: SelectedComponentBounds[]) => {
    clearSelectionEffects()
    if (outlinePassRef.current) {
      outlinePassRef.current.selectedObjects = components.map(({ marker }) => marker)
    }
    if (innerOutlinePassRef.current) {
      innerOutlinePassRef.current.selectedObjects = components.map(({ marker }) => marker)
    }
    const overlay = selectionOverlayRef.current
    if (!overlay) return

    selectionOverlayItemsRef.current = components.map((component) => {
      const element = document.createElement('div')
      element.className = 'viewer-selection-marker'
      element.dataset.designator = component.designator
      const leader = document.createElement('span')
      leader.className = 'viewer-selection-leader'
      const ring = document.createElement('span')
      ring.className = 'viewer-selection-ring'
      const label = document.createElement('span')
      label.className = 'viewer-selection-label'
      label.textContent = component.designator
      label.hidden = true
      element.append(leader, ring, label)
      overlay.appendChild(element)
      return {
        element,
        ring,
        leader,
        label,
        bounds: component.bounds.clone(),
        designator: component.designator,
      }
    })
  }

  const updateSelectionOverlay = (
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
  ) => {
    const items = selectionOverlayItemsRef.current
    if (items.length === 0) return
    const width = Math.max(canvas.clientWidth, 1)
    const height = Math.max(canvas.clientHeight, 1)
    const projected = new THREE.Vector3()
    const cameraSpace = new THREE.Vector3()
    const visibleItems = items.map((item) => {
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      let allInFront = true
      for (const x of [item.bounds.min.x, item.bounds.max.x]) {
        for (const y of [item.bounds.min.y, item.bounds.max.y]) {
          for (const z of [item.bounds.min.z, item.bounds.max.z]) {
            const corner = new THREE.Vector3(x, y, z)
            cameraSpace.copy(corner).applyMatrix4(camera.matrixWorldInverse)
            if (cameraSpace.z >= -camera.near) allInFront = false
            projected.copy(corner).project(camera)
            const screenX = (projected.x * 0.5 + 0.5) * width
            const screenY = (-projected.y * 0.5 + 0.5) * height
            minX = Math.min(minX, screenX)
            maxX = Math.max(maxX, screenX)
            minY = Math.min(minY, screenY)
            maxY = Math.max(maxY, screenY)
          }
        }
      }
      return {
        item,
        minX,
        maxX,
        minY,
        maxY,
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2,
        size: Math.max(maxX - minX, maxY - minY),
        visible: allInFront && maxX >= 0 && minX <= width && maxY >= 0 && minY <= height,
      }
    })
    const onscreen = visibleItems.filter((item) => item.visible)
    const spreadX = onscreen.length > 0
      ? Math.max(...onscreen.map((item) => item.centerX)) - Math.min(...onscreen.map((item) => item.centerX))
      : 0
    const spreadY = onscreen.length > 0
      ? Math.max(...onscreen.map((item) => item.centerY)) - Math.min(...onscreen.map((item) => item.centerY))
      : 0
    const dispersedSelection = items.length > 1 && Math.max(spreadX, spreadY) >= 120

    visibleItems.forEach(({ item, minX, maxX, minY, maxY, centerX, centerY, size, visible }) => {
      const showRing = visible && size < 8 && dispersedSelection
      const showHoverLabel = visible
        && size <= 18
        && hoveredDesignatorRef.current === item.designator
      item.element.hidden = !showRing && !showHoverLabel
      item.ring.hidden = !showRing
      item.leader.hidden = !showRing
      item.label.hidden = !showHoverLabel
      item.element.dataset.visibilityTier = size > 18 ? 'detail' : size >= 8 ? 'outline' : 'locator'
      item.element.dataset.projectedSize = size.toFixed(2)
      if (item.element.hidden) return

      let markerX = maxX + 12
      let markerY = minY - 10
      if (markerX > width - 9) markerX = minX - 12
      if (markerY < 9) markerY = maxY + 10
      markerX = THREE.MathUtils.clamp(markerX, 9, width - 9)
      markerY = THREE.MathUtils.clamp(markerY, 9, height - 9)
      item.element.style.transform = `translate3d(${markerX}px, ${markerY}px, 0)`

      if (showRing) {
        const targetX = THREE.MathUtils.clamp(markerX, minX, maxX)
        const targetY = THREE.MathUtils.clamp(markerY, minY, maxY)
        const deltaX = targetX - markerX
        const deltaY = targetY - markerY
        const lineLength = Math.max(Math.hypot(deltaX, deltaY) - 5, 0)
        item.leader.style.width = `${lineLength}px`
        item.leader.style.transform = `rotate(${Math.atan2(deltaY, deltaX)}rad)`
      }

      if (!showHoverLabel) return
      const labelWidth = Math.max(34, item.designator.length * 7 + 14)
      const labelHeight = 20
      const candidates = [
        { x: 9, y: -25 },
        { x: -labelWidth - 12, y: -28 },
        { x: 9, y: 9 },
        { x: -labelWidth - 12, y: 12 },
      ]
      const candidate = candidates.find(({ x, y }) => (
        markerX + x >= 4
        && markerX + x + labelWidth <= width - 4
        && markerY + y >= 4
        && markerY + y + labelHeight <= height - 4
      )) ?? candidates[0]
      item.label.style.width = `${labelWidth}px`
      item.label.style.transform = `translate3d(${candidate.x}px, ${candidate.y}px, 0)`
    })
  }

  const animateCameraToSelection = (root: THREE.Group, focus: SelectionCameraFocus) => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls) return false

    cancelCameraFocusAnimation()
    const startPosition = camera.position.clone()
    const startTarget = controls.target.clone()
    const startedAt = performance.now()
    const boundsRadius = focus.bounds.getSize(new THREE.Vector3()).length() / 2
    camera.near = Math.max(Math.min(
      startPosition.distanceTo(startTarget),
      focus.distance,
    ) / 1000, 0.02)
    camera.far = Math.max(camera.far, focus.distance + boundsRadius * 4)
    camera.updateProjectionMatrix()

    root.userData.selectionFocusApplied = true
    root.userData.selectionFocusCount = focus.matchedCount
    root.userData.selectionFocusDistance = focus.distance
    root.userData.selectionFocusMargin = selectionViewportMargin
    root.userData.selectionFocusCoverage = focus.screenCoverage
    root.userData.selectionFocusTarget = focus.target.toArray()
      .map((value) => Number(value.toFixed(3)))
      .join(',')
    root.userData.selectionFocusAnimation = 'running'

    const step = (now: number) => {
      const progress = Math.min((now - startedAt) / selectionFocusDurationMs, 1)
      const eased = 1 - (1 - progress) ** 3
      controls.target.lerpVectors(startTarget, focus.target, eased)
      camera.position.lerpVectors(startPosition, focus.position, eased)
      controls.update()

      if (progress < 1) {
        cameraFocusAnimationRef.current = requestAnimationFrame(step)
        return
      }

      controls.target.copy(focus.target)
      camera.position.copy(focus.position)
      camera.near = Math.max(focus.distance / 1000, 0.02)
      camera.updateProjectionMatrix()
      controls.update()
      root.userData.selectionFocusAnimation = 'complete'
      pixelCheckRequestedRef.current = true
      cameraFocusAnimationRef.current = null
    }

    cameraFocusAnimationRef.current = requestAnimationFrame(step)
    return true
  }

  useEffect(() => {
    onComponentSelectRef.current = onComponentSelect
    onClearSelectionRef.current = onClearSelection
  }, [onComponentSelect, onClearSelection])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    try {
      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x111613)

      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 2000)
      camera.up.set(0, 0, 1)
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.05
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      renderer.domElement.tabIndex = 0
      host.appendChild(renderer.domElement)

      const composer = new EffectComposer(renderer)
      const renderPass = new RenderPass(scene, camera)
      const outlinePass = new OutlinePass(new THREE.Vector2(1, 1), scene, camera)
      outlinePass.visibleEdgeColor.set(0x00e5ff)
      outlinePass.hiddenEdgeColor.set(0x00e5ff)
      outlinePass.edgeStrength = 4
      outlinePass.edgeGlow = 0.12
      outlinePass.edgeThickness = 2
      outlinePass.pulsePeriod = 0
      const innerOutlinePass = new OutlinePass(new THREE.Vector2(1, 1), scene, camera)
      innerOutlinePass.visibleEdgeColor.set(0xffffff)
      innerOutlinePass.hiddenEdgeColor.set(0xffffff)
      innerOutlinePass.edgeStrength = 2.6
      innerOutlinePass.edgeGlow = 0
      innerOutlinePass.edgeThickness = 0.75
      innerOutlinePass.pulsePeriod = 0
      const outputPass = new OutputPass()
      composer.addPass(renderPass)
      composer.addPass(outlinePass)
      composer.addPass(innerOutlinePass)
      composer.addPass(outputPass)

      const controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.075
      controls.screenSpacePanning = true
      controls.minDistance = 10
      controls.maxDistance = 10000
      const cancelFocusOnInteraction = () => cancelCameraFocusAnimation()
      controls.addEventListener('start', cancelFocusOnInteraction)
      controls.addEventListener('end', () => {
        pixelCheckRequestedRef.current = true
      })

      const raycaster = new THREE.Raycaster()
      const pointer = new THREE.Vector2()
      let pointerStart: { id: number; x: number; y: number } | null = null
      const findPlacementDesignator = (object: THREE.Object3D, root: THREE.Object3D) => {
        let current: THREE.Object3D | null = object
        while (current && current !== root) {
          if (!current.visible) return null
          const designator = current.userData.designator
          if (typeof designator === 'string' && designator) return designator
          current = current.parent
        }
        return null
      }
      const handlePointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return
        renderer.domElement.focus({ preventScroll: true })
        pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY }
      }
      const designatorAtPointer = (event: MouseEvent) => {
        const componentRoot = componentRootRef.current
        if (!componentRoot || !componentRoot.visible || !visibilityRef.current.components) return null
        const bounds = renderer.domElement.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) return null
        pointer.set(
          ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
          -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
        )
        raycaster.setFromCamera(pointer, camera)
        for (const intersection of raycaster.intersectObject(componentRoot, true)) {
          const designator = findPlacementDesignator(intersection.object, componentRoot)
          if (designator) return designator
        }
        return null
      }
      const handlePointerMove = (event: PointerEvent) => {
        hoveredDesignatorRef.current = designatorAtPointer(event)
        renderer.domElement.dataset.hoveredDesignator = hoveredDesignatorRef.current ?? ''
      }
      const handlePointerUp = (event: PointerEvent) => {
        const start = pointerStart
        pointerStart = null
        if (!start || start.id !== event.pointerId) return
        if ((event.clientX - start.x) ** 2 + (event.clientY - start.y) ** 2 > 36) return

        const designator = designatorAtPointer(event)
        if (!designator) return
        renderer.domElement.dataset.selectedDesignator = designator
        onComponentSelectRef.current(designator)
      }
      const clearPointerStart = () => {
        pointerStart = null
        hoveredDesignatorRef.current = null
        renderer.domElement.dataset.hoveredDesignator = ''
      }
      // 双击空白处（未命中任何元件）解除高亮；单击留给「选中元件 / 旋转视角」，
      // 所以要用双击才不会在拖拽旋转时误清选中。
      const handleDoubleClick = (event: MouseEvent) => {
        if (designatorAtPointer(event)) return
        renderer.domElement.dataset.selectedDesignator = ''
        onClearSelectionRef.current()
      }
      renderer.domElement.title = '单击元件以定位 BOM 行；双击空白处解除高亮'
      renderer.domElement.addEventListener('pointerdown', handlePointerDown)
      renderer.domElement.addEventListener('pointermove', handlePointerMove)
      renderer.domElement.addEventListener('pointerup', handlePointerUp)
      renderer.domElement.addEventListener('dblclick', handleDoubleClick)
      renderer.domElement.addEventListener('pointercancel', clearPointerStart)
      renderer.domElement.addEventListener('pointerleave', clearPointerStart)

      scene.add(new THREE.HemisphereLight(0xf7f4e8, 0x16211b, 2.1))
      const keyLight = new THREE.DirectionalLight(0xffffff, 3.2)
      keyLight.position.set(-55, -60, 95)
      keyLight.castShadow = true
      scene.add(keyLight)
      const fillLight = new THREE.DirectionalLight(0xd8e7ff, 1.35)
      fillLight.position.set(80, 30, 45)
      scene.add(fillLight)

      const grid = new THREE.GridHelper(300, 60, 0x314239, 0x202a25)
      grid.rotation.x = Math.PI / 2
      grid.position.z = -4
      grid.renderOrder = -10
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material]
      gridMaterials.forEach((material) => {
        material.depthTest = true
        material.depthWrite = false
        material.transparent = false
        material.opacity = 1
      })
      scene.add(grid)

      sceneRef.current = scene
      cameraRef.current = camera
      rendererRef.current = renderer
      outlinePassRef.current = outlinePass
      innerOutlinePassRef.current = innerOutlinePass
      controlsRef.current = controls
      gridRef.current = grid

      const resize = () => {
        const width = Math.max(host.clientWidth, 1)
        const height = Math.max(host.clientHeight, 1)
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
        renderer.setPixelRatio(pixelRatio)
        composer.setPixelRatio(pixelRatio)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height, false)
        composer.setSize(width, height)
        const drawingBufferSize = renderer.getDrawingBufferSize(new THREE.Vector2())
        renderer.domElement.dataset.canvasClientSize = `${width}x${height}`
        renderer.domElement.dataset.drawingBufferSize = `${drawingBufferSize.x}x${drawingBufferSize.y}`
        renderer.domElement.dataset.pixelRatio = String(pixelRatio)
        setViewportRevision((revision) => revision + 1)
      }
      const observer = new ResizeObserver(resize)
      observer.observe(host)
      resize()

      const cameraOffset = new THREE.Vector3()
      const animate = () => {
        controls.update()
        grid.position.z = camera.position.z >= 0 ? -4 : 4
        renderer.domElement.dataset.gridZ = String(grid.position.z)
        renderer.domElement.dataset.gridVisible = String(grid.visible)
        renderer.domElement.dataset.cameraPosition = camera.position.toArray()
          .map((value) => value.toFixed(3))
          .join(',')
        renderer.domElement.dataset.cameraTarget = controls.target.toArray()
          .map((value) => value.toFixed(3))
          .join(',')
        renderer.domElement.dataset.cameraDirection = cameraOffset
          .copy(camera.position)
          .sub(controls.target)
          .normalize()
          .toArray()
          .map((value) => value.toFixed(5))
          .join(',')
        const boardRoot = boardRootRef.current
        if (boardRoot) {
          applyBoardVisibility(boardRoot, visibilityRef.current, camera.position.z)
          const visibleSurfaceGroups = boardRoot.children.filter(
            (child) => child.visible && child.userData.surfaceSide,
          )
          renderer.domElement.dataset.viewSide = camera.position.z >= 0 ? 'top' : 'bottom'
          renderer.domElement.dataset.visibleTopGroups = String(
            visibleSurfaceGroups.filter((child) => child.userData.surfaceSide === 'top').length,
          )
          renderer.domElement.dataset.visibleBottomGroups = String(
            visibleSurfaceGroups.filter((child) => child.userData.surfaceSide === 'bottom').length,
          )
        }
        const componentRoot = componentRootRef.current
        if (componentRoot) {
          applyComponentVisibility(componentRoot, visibilityRef.current.components, camera.position.z)
          const placementMarkers = componentRoot.children.filter((child) => child.userData.placementMarker)
          renderer.domElement.dataset.cameraDistance = camera.position.distanceTo(controls.target).toFixed(3)
          renderer.domElement.dataset.alignmentMode = String(componentRoot.userData.alignmentMode)
          renderer.domElement.dataset.placementCount = String(componentRoot.userData.placementCount)
          renderer.domElement.dataset.placementInside = String(componentRoot.userData.insideCount)
          renderer.domElement.dataset.placementOutside = String(componentRoot.userData.outsideDesignators)
          renderer.domElement.dataset.modelMatched = String(componentRoot.userData.modelMatchedCount)
          renderer.domElement.dataset.modelLoaded = String(componentRoot.userData.modelLoadedCount)
          renderer.domElement.dataset.modelFailed = String(componentRoot.userData.modelFailedCount)
          renderer.domElement.dataset.visiblePlacements = String(
            placementMarkers.filter((child) => child.visible).length,
          )
          renderer.domElement.dataset.selectedPlacements = String(
            placementMarkers.filter((child) => child.userData.selected).length,
          )
          renderer.domElement.dataset.focusedPlacements = String(
            componentRoot.userData.selectionFocusCount ?? 0,
          )
          renderer.domElement.dataset.focusDistance = String(
            componentRoot.userData.selectionFocusDistance ?? '',
          )
          renderer.domElement.dataset.focusMargin = String(
            componentRoot.userData.selectionFocusMargin ?? '',
          )
          renderer.domElement.dataset.focusCoverage = String(
            componentRoot.userData.selectionFocusCoverage ?? '',
          )
          renderer.domElement.dataset.focusTarget = String(
            componentRoot.userData.selectionFocusTarget ?? '',
          )
          renderer.domElement.dataset.focusAnimation = String(
            componentRoot.userData.selectionFocusAnimation ?? '',
          )
          renderer.domElement.dataset.selectionRequested = String(
            componentRoot.userData.selectionRequestedCount ?? 0,
          )
          renderer.domElement.dataset.outlineSelected = String(outlinePass.selectedObjects.length)
          renderer.domElement.dataset.postureValid = String(componentRoot.userData.postureValidCount ?? 0)
          renderer.domElement.dataset.postureInvalid = String(
            (componentRoot.userData.postureInvalidDesignators as string[] | undefined)?.join(',') ?? '',
          )
          renderer.domElement.dataset.contactValid = String(componentRoot.userData.contactValidCount ?? 0)
          renderer.domElement.dataset.contactInvalid = String(
            (componentRoot.userData.contactInvalidDesignators as string[] | undefined)?.join(',') ?? '',
          )
          renderer.domElement.dataset.topPlacementRotations = placementMarkers
            .filter((marker) => marker.userData.surfaceSide === 'top')
            .map((marker) => `${marker.userData.designator}:${marker.userData.appliedPlacementRotation}`)
            .join(',')
          renderer.domElement.dataset.bottomPlacementRotations = placementMarkers
            .filter((marker) => marker.userData.surfaceSide === 'bottom')
            .map((marker) => `${marker.userData.designator}:${marker.userData.appliedPlacementRotation}`)
            .join(',')
          renderer.domElement.dataset.rotatedPlacements = String(
            placementMarkers.filter((child) => child.userData.appliedRotationZ !== 0).length,
          )
          renderer.domElement.dataset.flippedPlacements = String(
            placementMarkers.filter((child) => child.userData.appliedRotationX !== 0).length,
          )
          const movedMarkers = placementMarkers.filter((child) => (
            child.userData.appliedOffsetX !== 0
            || child.userData.appliedOffsetY !== 0
            || child.userData.appliedOffsetZ !== 0
          ))
          renderer.domElement.dataset.movedPlacements = String(movedMarkers.length)
          renderer.domElement.dataset.placementOffsets = movedMarkers
            .map((marker) => `${marker.userData.designator}:${marker.userData.appliedOffsetX},${marker.userData.appliedOffsetY},${marker.userData.appliedOffsetZ}`)
            .join(',')
        } else {
          renderer.domElement.dataset.placementCount = '0'
          renderer.domElement.dataset.placementInside = '0'
          renderer.domElement.dataset.modelMatched = '0'
          renderer.domElement.dataset.modelLoaded = '0'
          renderer.domElement.dataset.modelFailed = '0'
          renderer.domElement.dataset.visiblePlacements = '0'
          renderer.domElement.dataset.selectedPlacements = '0'
          renderer.domElement.dataset.focusedPlacements = '0'
          renderer.domElement.dataset.focusDistance = ''
          renderer.domElement.dataset.focusMargin = ''
          renderer.domElement.dataset.focusCoverage = ''
          renderer.domElement.dataset.focusTarget = ''
          renderer.domElement.dataset.focusAnimation = ''
          renderer.domElement.dataset.selectionRequested = '0'
          renderer.domElement.dataset.outlineSelected = '0'
          renderer.domElement.dataset.postureValid = '0'
          renderer.domElement.dataset.postureInvalid = ''
          renderer.domElement.dataset.contactValid = '0'
          renderer.domElement.dataset.contactInvalid = ''
          renderer.domElement.dataset.topPlacementRotations = ''
          renderer.domElement.dataset.bottomPlacementRotations = ''
          renderer.domElement.dataset.rotatedPlacements = '0'
          renderer.domElement.dataset.flippedPlacements = '0'
          renderer.domElement.dataset.movedPlacements = '0'
          renderer.domElement.dataset.placementOffsets = ''
        }
        updateSelectionOverlay(camera, renderer.domElement)
        composer.render()
        if (pixelCheckRequestedRef.current) {
          const context = renderer.getContext()
          const width = context.drawingBufferWidth
          const height = context.drawingBufferHeight
          const pixels = new Uint8Array(width * height * 4)
          context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels)
          const step = Math.max(1, Math.floor((width * height) / 24000))
          const colors = new Set<number>()
          let nonDark = 0
          let samples = 0
          for (let index = 0; index < width * height; index += step) {
            const offset = index * 4
            const red = pixels[offset]
            const green = pixels[offset + 1]
            const blue = pixels[offset + 2]
            colors.add((Math.round(red / 16) << 8) | (Math.round(green / 16) << 4) | Math.round(blue / 16))
            if (red + green + blue > 90) nonDark += 1
            samples += 1
          }
          renderer.domElement.dataset.pixelSamples = String(samples)
          renderer.domElement.dataset.pixelNonDark = String(nonDark)
          renderer.domElement.dataset.pixelColors = String(colors.size)
          renderer.domElement.dataset.renderObjects = String(scene.children.length)
          renderer.domElement.dataset.pixelCheck = 'complete'
          pixelCheckRequestedRef.current = false
        }
        animationRef.current = requestAnimationFrame(animate)
      }
      animate()

      return () => {
        observer.disconnect()
        renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
        renderer.domElement.removeEventListener('pointermove', handlePointerMove)
        renderer.domElement.removeEventListener('pointerup', handlePointerUp)
        renderer.domElement.removeEventListener('dblclick', handleDoubleClick)
        renderer.domElement.removeEventListener('pointercancel', clearPointerStart)
        renderer.domElement.removeEventListener('pointerleave', clearPointerStart)
        if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
        cancelCameraFocusAnimation()
        clearSelectionEffects()
        controls.removeEventListener('start', cancelFocusOnInteraction)
        controls.dispose()
        outlinePass.dispose()
        innerOutlinePass.dispose()
        outputPass.dispose()
        composer.dispose()
        renderer.dispose()
        renderer.domElement.remove()
        scene.clear()
        outlinePassRef.current = null
        innerOutlinePassRef.current = null
      }
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : 'WebGL 初始化失败')
    }
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (boardRootRef.current) {
      scene.remove(boardRootRef.current)
      disposeObject(boardRootRef.current)
      boardRootRef.current = null
    }
    if (!board) return

    try {
      const renderer = rendererRef.current
      const maxAnisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 4
      const maxTextureSize = renderer?.capabilities.maxTextureSize ?? 4096
      const object = buildBoardObject(
        board,
        thickness,
        boardColor,
        maxAnisotropy,
        maxTextureSize,
        () => {
        pixelCheckRequestedRef.current = true
        },
      )
      scene.add(object)
      boardRootRef.current = object
      pixelCheckRequestedRef.current = true
      setRenderError(null)
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : '3D 几何生成失败')
    }
  }, [board, thickness, boardColor])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    cancelCameraFocusAnimation()
    clearSelectionEffects()
    setSelectionNotice(null)
    if (componentRootRef.current) {
      componentRootRef.current.userData.disposed = true
      scene.remove(componentRootRef.current)
      disposeObject(componentRootRef.current)
      componentRootRef.current = null
    }
    if (!board || !alignment) return

    let object: THREE.Group | null = null
    const focusSelectionWhenReady = () => {
      if (!object || object.userData.selectionFocusResolved || selectedDesignators.length === 0) return
      const selectedMarkers = object.children.filter((child) => child.userData.selected)
      if (selectedMarkers.length === 0) {
        object.userData.selectionFocusResolved = true
        setSelectionNotice('未找到对应的 PCB 元件')
        return
      }
      const selectionIsReady = selectedMarkers.every(
        (marker) => marker.userData.modelLoaded || marker.userData.modelError,
      )
      if (!selectionIsReady) return

      const camera = cameraRef.current
      const controls = controlsRef.current
      const canvas = rendererRef.current?.domElement
      if (!camera || !controls || !canvas) return
      const focus = calculateSelectionCameraFocus(object, camera, controls, canvas)
      object.userData.selectionFocusResolved = true
      if (!focus) {
        setSelectionNotice('未找到对应的 PCB 元件')
        return
      }
      setSelectionNotice(null)
      showSelectionEffects(focus.components)
      if (animateCameraToSelection(object, focus)) pixelCheckRequestedRef.current = true
    }

    object = createPlacementObject(
      board,
      thickness,
      alignment,
      bomItems,
      footprintModelOverrides,
      selectedDesignators,
      (bomItemId) => bomRowOrientationsRef.current.get(bomItemId),
      () => {
        pixelCheckRequestedRef.current = true
        focusSelectionWhenReady()
      },
    )
    object.userData.selectionRequestedCount = selectedDesignators.length
    applyBomRowOrientations(object, bomRowOrientationsRef.current)
    scene.add(object)
    componentRootRef.current = object
    if (cameraRef.current) applyComponentVisibility(object, visibility.components, cameraRef.current.position.z)
    focusSelectionWhenReady()
    pixelCheckRequestedRef.current = true
  }, [board, thickness, alignment, bomItems, footprintModelOverrides, selectedDesignators, selectionRevision])

  useEffect(() => {
    bomRowOrientationsRef.current = bomRowOrientations
    const root = componentRootRef.current
    if (!root) return
    applyBomRowOrientations(root, bomRowOrientations)
    pixelCheckRequestedRef.current = true
  }, [bomRowOrientations])

  useEffect(() => {
    visibilityRef.current = visibility
    const root = boardRootRef.current
    if (root && cameraRef.current) applyBoardVisibility(root, visibility, cameraRef.current.position.z)
    const components = componentRootRef.current
    if (components && cameraRef.current) {
      applyComponentVisibility(components, visibility.components, cameraRef.current.position.z)
    }
    if (gridRef.current) gridRef.current.visible = visibility.grid
    pixelCheckRequestedRef.current = true
  }, [visibility, board, thickness, boardColor])

  useEffect(() => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls || !board) return
    cancelCameraFocusAnimation()
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2)
    const fitHeight = board.heightMm / (2 * Math.tan(halfFov))
    const fitWidth = board.widthMm / (2 * Math.tan(halfFov) * Math.max(camera.aspect, 0.1))
    const distance = Math.max(Math.max(fitHeight, fitWidth) * (cameraPreset === 'iso' ? 1.55 : 1.2), 48)

    if (cameraPreset === 'top') {
      camera.position.set(0, 0, distance)
      camera.up.set(0, 1, 0)
    } else if (cameraPreset === 'bottom') {
      camera.position.set(0, 0, -distance)
      camera.up.set(0, 1, 0)
    } else {
      camera.position.set(0.76, -1, 0.82).normalize().multiplyScalar(distance)
      camera.up.set(0, 0, 1)
    }
    controls.target.set(0, 0, 0)
    camera.near = Math.max(distance / 1000, 0.05)
    camera.far = distance * 12
    camera.updateProjectionMatrix()
    controls.update()
    pixelCheckRequestedRef.current = true
  }, [board, cameraPreset, cameraRevision, viewportRevision])

  return (
    <div className="viewer-host" ref={hostRef}>
      <div className="viewer-selection-overlay" ref={selectionOverlayRef} aria-hidden="true" />
      {renderError && (
        <div className="viewer-error" role="alert">
          <strong>无法生成 3D 视图</strong>
          <span>{renderError}</span>
        </div>
      )}
      {selectionNotice && (
        <div className="viewer-selection-notice" role="status">
          {selectionNotice}
        </div>
      )}
    </div>
  )
}
