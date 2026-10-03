"""Persistent offscreen GPU renderer. No browser, window, or per-frame CAD export."""
import math
import threading
import time

import moderngl
import numpy as np
from PIL import Image
import trimesh

VERTEX = '''#version 330
uniform mat4 mvp;
in vec3 position;
in vec3 normal;
in vec4 color;
out vec3 n;
out vec4 c;
void main() { gl_Position = mvp * vec4(position, 1.0); n = normal; c = color; }
'''
FRAGMENT = '''#version 330
in vec3 n;
in vec4 c;
out vec4 pixel;
void main() {
    vec3 N = normalize(n);
    float key = abs(dot(N, normalize(vec3(-0.4, -0.6, 1.0))));
    float fill = abs(dot(N, normalize(vec3(0.7, 0.3, 0.4))));
    vec3 lit = c.rgb * (0.35 + 0.5 * key + 0.15 * fill);
    pixel = vec4(pow(lit, vec3(1.0 / 2.2)), 1.0);
}
'''


def normalized(value):
    return value / max(np.linalg.norm(value), 1e-10)


class Renderer:
    def __init__(self, path):
        self.context = moderngl.create_standalone_context()
        self.device = self.context.info['GL_RENDERER']
        self.program = self.context.program(vertex_shader=VERTEX, fragment_shader=FRAGMENT)
        scene = trimesh.load_scene(path, process=False)
        center = scene.bounds.mean(axis=0)
        radius = max(scene.extents) / 2
        # KiCad's glTF is Y-up; present the thin board axis as Z-up to the camera.
        thin = int(np.argmin(scene.extents))
        axes = [i for i in range(3) if i != thin] + [thin]
        buffers = []
        for node in scene.graph.nodes_geometry:
            matrix, name = scene.graph[node]
            mesh = scene.geometry[name]
            if not hasattr(mesh, 'faces') or not len(mesh.faces):
                continue
            vertices = trimesh.transform_points(mesh.vertices, matrix)
            vertices = ((vertices - center) / radius)[:, axes]
            triangles = vertices[mesh.faces]
            normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
            normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-10)
            material = getattr(mesh.visual, 'material', None)
            factor = getattr(material, 'baseColorFactor', None)
            if factor is None:
                factor = getattr(material, 'diffuse', [160, 170, 175, 255])
            factor = np.asarray(factor, dtype='f4')
            if factor.max() > 1:
                factor /= 255
            colors = np.broadcast_to(factor, (len(triangles) * 3, 4))
            buffers.append(np.concatenate((triangles.reshape(-1, 3), np.repeat(normals, 3, axis=0), colors), axis=1).astype('f4'))
        if not buffers:
            raise ValueError('No triangles in the exported board model')
        data = np.concatenate(buffers)
        self.triangles = len(data) // 3
        self.buffer = self.context.buffer(data.tobytes())
        self.vao = self.context.vertex_array(self.program, [(self.buffer, '3f 3f 4f', 'position', 'normal', 'color')])
        self.context.enable(moderngl.DEPTH_TEST)
        self.framebuffer = None
        self.size = None

    def frame(self, yaw=45, pitch=45, zoom=1, width=960, height=640):
        if self.size != (width, height):
            if self.framebuffer:
                self.framebuffer.release()
            self.framebuffer = self.context.simple_framebuffer((width, height), components=3)
            self.size = width, height
        self.framebuffer.use()
        self.context.viewport = (0, 0, width, height)
        self.context.clear(18/255, 25/255, 29/255, 1, depth=1)
        yaw, pitch = math.radians(yaw), math.radians(pitch)
        direction = np.array([math.cos(pitch)*math.sin(yaw), -math.cos(pitch)*math.cos(yaw), math.sin(pitch)])
        eye = direction * 4
        forward = normalized(-eye)
        right = normalized(np.cross(forward, [0, 0, 1]))
        up = np.cross(right, forward)
        view = np.eye(4)
        view[:3, :3] = np.array([right, up, -forward])
        view[:3, 3] = -view[:3, :3] @ eye
        # Orthographic CAD camera; zoom changes scale without moving clipping planes.
        half_y = 1.45 / max(.3, zoom)
        half_x = half_y * width / height
        projection = np.diag([1/half_x, 1/half_y, -2/20, 1.0])
        projection[2, 3] = -1
        mvp = (projection @ view).astype('f4')
        self.program['mvp'].write(mvp.T.tobytes())
        self.vao.render(moderngl.TRIANGLES)
        pixels = self.framebuffer.read(components=3, alignment=1)
        return Image.frombytes('RGB', (width, height), pixels).transpose(Image.Transpose.FLIP_TOP_BOTTOM)

    def close(self):
        if self.framebuffer:
            self.framebuffer.release()
        self.vao.release()
        self.buffer.release()
        self.program.release()
        self.context.release()


class GPUWorker:
    """One context-owning thread, coalescing camera requests rather than queuing lag."""
    def __init__(self, callback):
        self.callback = callback
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stop = threading.Event()
        self.pending = None
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def request(self, path, token, **camera):
        with self.lock:
            self.pending = path, token, camera
        self.wake.set()

    def run(self):
        renderer, loaded = None, None
        try:
            while not self.stop.is_set():
                self.wake.wait(.2)
                self.wake.clear()
                with self.lock:
                    pending, self.pending = self.pending, None
                if not pending:
                    continue
                path, token, camera = pending
                try:
                    if path != loaded:
                        if renderer:
                            renderer.close()
                        renderer = None
                        renderer = Renderer(path)
                        loaded = path
                    started = time.perf_counter()
                    image = renderer.frame(**camera)
                    self.callback(token, image, renderer.device, time.perf_counter()-started, None)
                except Exception as exc:
                    self.callback(token, None, '', 0, str(exc))
        finally:
            if renderer:
                renderer.close()

    def close(self):
        self.stop.set()
        self.wake.set()
        self.thread.join(timeout=3)
