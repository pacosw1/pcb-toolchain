// Interactive KiCad geometry: batched export, demand-driven rendering and studio lighting.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

function disposeScene(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>()
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose()); geometries.forEach(g => g.dispose())
}

export function Viewer3D({ pcb }: { pcb: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState('Preparing the 3D model…')
  const [info, setInfo] = useState<string | null>(null)
  const viewRef = useRef<{ fit: (dir: THREE.Vector3) => void } | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false, raf = 0, frames = 0
    const request = new AbortController()
    setState('Preparing the 3D model…'); setInfo(null); viewRef.current = null
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setClearColor(0xc4c6d5)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.75
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.shadowMap.autoUpdate = false
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    const environment = pmrem.fromScene(room, 0.04)
    scene.environment = environment.texture
    room.dispose(); pmrem.dispose()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 0.2))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(1, 2, 1.5); scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.3)
    fill.position.set(-1, 0.4, -1); scene.add(fill)
    const camera = new THREE.PerspectiveCamera(35, 1, 0.0001, 100)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    controls.dampingFactor = 0.12
    const invalidate = (): void => { if (!disposed && !raf && !document.hidden) raf = requestAnimationFrame(draw) }
    function draw(): void {
      raf = 0
      if (disposed || document.hidden) return
      renderer.render(scene, camera)
      // Read-only diagnostics used by performance tests; not part of the product UI.
      el!.dataset.frames = String(++frames)
      el!.dataset.drawCalls = String(renderer.info.render.calls)
      el!.dataset.triangles = String(renderer.info.render.triangles)

    }
    let lastWidth = 0, lastHeight = 0
    const resize = (): void => {
      const w = el.clientWidth, h = el.clientHeight
      if (!w || !h) return
      if (w === lastWidth && h === lastHeight) { invalidate(); return }
      lastWidth = w; lastHeight = h
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); invalidate()
    }
    const interactionStart = (): void => { renderer.setPixelRatio(1); resize() }
    const interactionEnd = (): void => { renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); resize() }
    const visibility = (): void => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0 } else invalidate() }
    controls.addEventListener('change', invalidate)
    controls.addEventListener('start', interactionStart); controls.addEventListener('end', interactionEnd)
    document.addEventListener('visibilitychange', visibility)
    const ro = new ResizeObserver(resize); ro.observe(el); resize()

    void (async () => {
      const r = await window.api.boardGlb(pcb)
      if (disposed) return
      setState('Loading 3D geometry…')
      const response = await fetch(r.url, { signal: request.signal })
      if (!response.ok) throw new Error(`Model load returned ${response.status}`)
      const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '')
      if (disposed) { disposeScene(gltf.scene); return }
      const model = gltf.scene
      scene.add(model)
      const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3())
      const radius = Math.max(size.length() / 2, 0.0001)
      // Native KiCad's presentation render uses neutral key/fill lighting and a shadow floor.
      // Match the board display palette; CAD faces without PBR properties use a dielectric preview.
      const boardMaterials = new Set<number>()
      for (const mesh of gltf.parser.json.meshes ?? []) {
        if (/_(soldermask|PCB|copper|pad|via|silkscreen)$/.test(mesh.name ?? '')) {
          for (const primitive of mesh.primitives) if (typeof primitive.material === 'number') boardMaterials.add(primitive.material)
        }
      }
      const configured = new Set<THREE.Material>()
      model.traverse(object => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        mesh.castShadow = materials.every(material => !material.transparent || material.opacity >= 0.95)
        mesh.receiveShadow = true
        for (const material of materials) {
          if (!(material instanceof THREE.MeshStandardMaterial) || configured.has(material)) continue
          configured.add(material)
          // GLTF defaults metallic=1 when the CAD exporter supplied only a diffuse color.
          // A full-metal black package/green substrate is not KiCad's material model.
          const association = gltf.parser.associations.get(material)
          const exported = association?.materials === undefined ? null : gltf.parser.json.materials?.[association.materials]?.pbrMetallicRoughness
          // KiCad's named board layers carry its display-space palette; normalize it
          // to the linear-light space used by the physically based renderer.
          if (association?.materials !== undefined && boardMaterials.has(association.materials)) material.color.convertSRGBToLinear()
          if (exported && exported.metallicFactor === undefined) material.metalness = 0
          if (exported && exported.roughnessFactor === undefined) material.roughness = 0.6
          material.envMapIntensity = 0.25
        }
      })
      key.position.copy(center).add(new THREE.Vector3(radius * 0.8, radius * 2.2, radius * 1.4))
      key.target.position.copy(center); scene.add(key.target)
      key.castShadow = true; key.shadow.autoUpdate = false; key.shadow.needsUpdate = true; key.shadow.mapSize.set(2048, 2048)
      key.shadow.camera.left = -radius * 1.25; key.shadow.camera.right = radius * 1.25
      key.shadow.camera.top = radius * 1.25; key.shadow.camera.bottom = -radius * 1.25
      key.shadow.camera.near = radius * 0.01; key.shadow.camera.far = radius * 6
      key.shadow.normalBias = radius * 0.0002; key.shadow.bias = -0.00005
      key.shadow.camera.updateProjectionMatrix()
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(radius * 8, radius * 8), new THREE.ShadowMaterial({ opacity: 0.22 }))
      floor.rotation.x = -Math.PI / 2; floor.position.set(center.x, box.min.y - radius * 0.015, center.z)
      floor.receiveShadow = true; scene.add(floor)
      renderer.shadowMap.needsUpdate = true
      const fit = (dir: THREE.Vector3): void => {
        const dist = radius / Math.sin((camera.fov * Math.PI) / 360)
        camera.position.copy(center).add(dir.clone().normalize().multiplyScalar(dist * 1.1))
        camera.near = dist / 100; camera.far = dist * 20; camera.updateProjectionMatrix()
        controls.target.copy(center); controls.update(); invalidate()
      }
      viewRef.current = { fit }; fit(new THREE.Vector3(0.6, 1, 0.9))
      let meshes = 0; model.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes++ })
      setInfo(`${(size.x * 1000).toFixed(1)} × ${(size.z * 1000).toFixed(1)} mm · ${(r.size / 1e6).toFixed(1)} MB`)
      el.dataset.meshes = String(meshes)
      setState(''); invalidate()
    })().catch(error => { if (!disposed) setState(`3D load failed: ${error}`) })

    return () => {
      disposed = true; viewRef.current = null; request.abort(); cancelAnimationFrame(raf)
      ro.disconnect(); document.removeEventListener('visibilitychange', visibility)
      controls.removeEventListener('change', invalidate); controls.removeEventListener('start', interactionStart); controls.removeEventListener('end', interactionEnd)
      controls.dispose(); disposeScene(scene); environment.dispose(); renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [pcb])

  const view = (x: number, y: number, z: number): void => viewRef.current?.fit(new THREE.Vector3(x, y, z))
  return <div className="boardview">
    <div className="boardview-bar">
      <span style={{ color: 'var(--dim)', fontSize: 12 }}>View</span>
      <button type="button" className="toggle" onClick={() => view(0.6, 1, 0.9)}>Iso</button>
      <button type="button" className="toggle" onClick={() => view(0, 1, 0.0001)}>Top</button>
      <button type="button" className="toggle" onClick={() => view(0, -1, 0.0001)}>Bottom</button>
      <button type="button" className="toggle" onClick={() => view(0, 0.25, 1)}>Front</button>
      <span style={{ flex: '1 1 auto' }} /><span style={{ color: 'var(--dim)', fontSize: 12 }} aria-label="3D model info">{info ?? ''}</span>
    </div>
    <div className="boardview-canvas" ref={host} role="img" aria-label="3D board view">{state ? <div className="overlay-msg">{state}</div> : null}</div>
  </div>
}
