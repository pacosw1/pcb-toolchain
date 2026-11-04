// 3D board view: the board's binary glTF from kicad-cli (with part models), in three.js with orbit controls.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export function Viewer3D({ pcb }: { pcb: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<string>('Exporting the 3D model (first time for this board version takes a few seconds)…')
  const [info, setInfo] = useState<string | null>(null)
  const viewRef = useRef<{ fit: (dir: THREE.Vector3) => void } | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x0a0d12)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 2.5)
    sun.position.set(1, 2, 1.5)
    scene.add(sun)
    const camera = new THREE.PerspectiveCamera(35, 1, 0.0001, 100)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    const resize = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / Math.max(1, h)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    let raf = 0
    const tick = (): void => {
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    window.api
      .boardGlb(pcb)
      .then((r) => {
        if (disposed) return
        setState(r.cached ? 'Loading cached 3D model…' : 'Loading 3D model…')
        new GLTFLoader().load(
          r.url,
          (gltf) => {
            if (disposed) return
            const model = gltf.scene
            scene.add(model) // glTF is Y-up; kicad-cli writes it that way (top side towards +Y)
            const box = new THREE.Box3().setFromObject(model)
            const size = box.getSize(new THREE.Vector3())
            const center = box.getCenter(new THREE.Vector3())
            const radius = size.length() / 2
            const fit = (dir: THREE.Vector3): void => {
              const dist = radius / Math.sin((camera.fov * Math.PI) / 360)
              camera.position.copy(center).add(dir.clone().normalize().multiplyScalar(dist * 0.9))
              camera.near = dist / 100
              camera.far = dist * 10
              camera.updateProjectionMatrix()
              controls.target.copy(center)
              controls.update()
            }
            viewRef.current = { fit }
            fit(new THREE.Vector3(0.6, 1, 0.9))
            let meshes = 0
            model.traverse((o) => {
              if ((o as THREE.Mesh).isMesh) meshes++
            })
            setInfo(`${(size.x * 1000).toFixed(1)} × ${(size.z * 1000).toFixed(1)} mm · ${meshes} meshes · ${(r.size / 1e6).toFixed(1)} MB`)
            setState('')
          },
          undefined,
          (e) => setState(`3D load failed: ${e}`)
        )
      })
      .catch((e) => setState(`3D export failed: ${e}`))

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose?.()
      })
      el.removeChild(renderer.domElement)
    }
  }, [pcb])

  const view = (x: number, y: number, z: number): void => viewRef.current?.fit(new THREE.Vector3(x, y, z))

  return (
    <div className="boardview">
      <div className="boardview-bar">
        <span style={{ color: 'var(--dim)', fontSize: 12 }}>View</span>
        <button type="button" className="toggle" onClick={() => view(0.6, 1, 0.9)}>
          Iso
        </button>
        <button type="button" className="toggle" onClick={() => view(0, 1, 0.0001)}>
          Top
        </button>
        <button type="button" className="toggle" onClick={() => view(0, -1, 0.0001)}>
          Bottom
        </button>
        <button type="button" className="toggle" onClick={() => view(0, 0.25, 1)}>
          Front
        </button>
        <span style={{ flex: '1 1 auto' }} />
        <span style={{ color: 'var(--dim)', fontSize: 12 }} aria-label="3D model info">
          {info ?? ''}
        </span>
      </div>
      <div className="boardview-canvas" ref={host} role="img" aria-label="3D board view">
        {state ? <div className="overlay-msg">{state}</div> : null}
      </div>
    </div>
  )
}
