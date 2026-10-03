import tempfile
import unittest
from pathlib import Path
import trimesh
from board_gpu import Renderer


class GPUFrameTests(unittest.TestCase):
    def test_camera_updates_reuse_geometry_and_change_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / 'board.glb'
            scene = trimesh.Scene(trimesh.creation.box(extents=(2, 1, .15)))
            model.write_bytes(scene.export(file_type='glb'))
            renderer = Renderer(str(model))
            try:
                buffer = renderer.buffer
                first = renderer.frame(yaw=15, width=320, height=240)
                second = renderer.frame(yaw=75, width=320, height=240)
                self.assertEqual(first.size, (320, 240))
                self.assertNotEqual(first.tobytes(), second.tobytes())
                self.assertIs(renderer.buffer, buffer)
                self.assertTrue(renderer.device)
            finally:
                renderer.close()


if __name__ == '__main__':
    unittest.main()
