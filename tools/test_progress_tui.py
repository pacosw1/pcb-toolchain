import asyncio
from pathlib import Path
import unittest
from unittest.mock import patch

import progress
from progress_tui import Workbench
from textual.widgets import TabbedContent
from textual import events
from PIL import Image
from board_stage import Stage


class WorkbenchTests(unittest.IsolatedAsyncioTestCase):
    async def test_raw_terminal_pointer_events(self):
        # Real terminal driver events have widget=None. Pilot.click supplies a widget,
        # so using only Pilot clicks misses this production input path.
        def raw(kind, x, y, button=0):
            return kind(None, x, y, 0, 0, button, False, False, False, screen_x=x, screen_y=y)

        with patch.object(Stage, 'watcher'), patch.object(Stage, 'renderer'):
            app = Workbench(progress.Dashboard(120, cached=True), image_protocol='halfcell', follow=False)
            async with app.run_test(size=(140, 52)) as pilot:
                await pilot.pause(.2)
                app.source_image = Image.new('RGB', (400, 300), '#559977')
                app.show_image()
                app.query_one('#visual-empty').display = False
                await pilot.pause(.1)
                image = app.query_one('#board-image')
                x, y = image.region.center
                app.post_message(raw(events.MouseScrollUp, x, y))
                await pilot.pause(.1)
                self.assertEqual(app.zoom, 1.25)
                app.post_message(raw(events.MouseDown, x, y, 1))
                await pilot.pause(.1)
                self.assertIs(app.mouse_captured, image)
                app.post_message(raw(events.MouseMove, x+4, y+2, 1))
                await pilot.pause(.1)
                self.assertNotEqual(app.pan, (.5, .5))
                # Release outside the image must release the image's capture.
                app.post_message(raw(events.MouseUp, 1, 1, 1))
                await pilot.pause(.1)
                self.assertIsNone(app.drag)
                self.assertIsNone(app.mouse_captured)
                app.mode = '3d'
                yaw, pitch = app.rotation, app.pitch
                with patch.object(app, 'request_gpu') as frame:
                    app.post_message(raw(events.MouseDown, x, y, 1))
                    await pilot.pause(.1)
                    app.post_message(raw(events.MouseMove, x+3, y+1, 1))
                    await pilot.pause(.1)
                    self.assertNotEqual(app.rotation, yaw)
                    self.assertNotEqual(app.pitch, pitch)
                    frame.assert_called()
                    app.post_message(raw(events.MouseUp, 1, 1, 1))
                    await pilot.pause(.1)
                    self.assertIsNone(app.mouse_captured)
                zoom = app.zoom
                app.post_message(raw(events.MouseScrollDown, 1, 1))
                app.post_message(raw(events.MouseDown, 1, 1, 1))
                app.post_message(raw(events.MouseUp, 1, 1, 1))
                await pilot.pause(.1)
                self.assertEqual(app.zoom, zoom)
                app.on_mouse_scroll_up(raw(events.MouseScrollUp, -100, -100))

    async def test_compact_layout_keeps_stage_visible(self):
        app = Workbench(progress.Dashboard(120, cached=True), image_protocol='halfcell', follow=False)
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause(.2)
            self.assertTrue(app.has_class('compact'))
            region = app.query_one('#visual-stage').region
            self.assertGreaterEqual(region.height, 8)
            self.assertLessEqual(region.bottom, 23)
            await pilot.press('c')
            self.assertFalse(app.query_one('#visual-stage').display)
            await pilot.press('1')
            self.assertTrue(app.query_one('#visual-stage').display)

    async def test_board_navigation_and_tabs(self):
        dashboard = progress.Dashboard(120, cached=True)
        app = Workbench(dashboard, image_protocol='halfcell', follow=False)
        async with app.run_test(size=(140, 52)) as pilot:
            await pilot.pause(0.4)
            self.assertEqual(app.selected, 'BACKUP-POWER')
            await pilot.press('down')
            self.assertEqual(app.selected, 'BASE-PWR')
            await pilot.press('c')
            self.assertEqual(app.query_one(TabbedContent).active, 'changes')
            await pilot.click('#card-input-4d2a')
            self.assertEqual(app.selected, 'INPUT-4D2A')
            await pilot.press('w')
            app.load_visual()
            for _ in range(24):
                if app.source_image is not None:
                    break
                await pilot.pause(.25)
            self.assertIsNotNone(app.source_image)
            app.save_screenshot('workbench.svg', path=str(dashboard.directory))
            await pilot.press('4')
            app.load_visual()
            for _ in range(80):
                if app.source_image is not None:
                    break
                await pilot.pause(.25)
            self.assertFalse(app.gpu_failed)
            self.assertIsNotNone(app.model_path)
            self.assertIsNotNone(app.source_image)
            before = app.source_image.tobytes()
            model = app.model_path
            await pilot.press('right')
            await pilot.pause(.3)
            self.assertEqual(app.model_path, model)
            self.assertNotEqual(app.source_image.tobytes(), before)
            app.save_screenshot('workbench-3d.svg', path=str(dashboard.directory))


if __name__ == '__main__':
    unittest.main()
