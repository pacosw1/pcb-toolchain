"""Textual workbench for live board progress."""
import time
import threading
import logging
from pathlib import Path
from PIL import Image as PILImage
from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.message import Message
from textual.errors import NoWidget
from textual.containers import Container, Horizontal, Vertical, VerticalScroll
from textual.widgets import Button, Footer, Label, Static, TabbedContent, TabPane, Select
logging.getLogger('textual_image._terminal').setLevel(logging.CRITICAL)
from textual_image.widget import Image, TGPImage, SixelImage, HalfcellImage

import progress
from board_stage import Stage
from board_gpu import GPUWorker


class GPUFrame(Message):
    def __init__(self, token, image, device, duration, error):
        super().__init__()
        self.values = token, image, device, duration, error


class BoardCard(Static, can_focus=True):
    def __init__(self, board):
        super().__init__(board, id='card-' + board.lower(), classes='board-card')
        self.board = board

    def on_focus(self):
        self.app.select_board(self.board, pin=not self.app.initializing)

    def on_click(self):
        self.focus()

    def on_key(self, event):
        if event.key in ('down', 'up'):
            if event.key == 'down':
                self.app.action_next_board()
            else:
                self.app.action_previous_board()
            event.prevent_default()
            event.stop()

    def refresh_row(self, row):
        u, e, p = row['counts']
        text = Text()
        text.append(self.board + '\n', style='bold #e7b78d')
        if self.app.size.width < 110 or self.app.size.height < 40:
            text.append(f'{u} open  {e} err\n', style='#d1dce1')
            text.append(f'{p} parity / ' + ('edited' if row['dirty'] else 'clean'), style='#849da7')
            text.append('\n' + ('Routing' if 'Routing' in row['observed'] else 'Checking' if 'DRC' in row['observed'] else 'No process'), style='#8cac9f')
            self.update(text)
            return
        text.append('\n')
        text.append(f'{u!s:>4}', style='bold #f0f1ed')
        text.append(' open   ', style='#879da5')
        text.append(f'{e} errors', style='#df9586' if isinstance(e, int) and e else '#8ab8a6')
        text.append(f'\n{p} parity  /  ', style='#879da5')
        text.append('modified' if row['dirty'] else 'Git clean', style='#cfab82' if row['dirty'] else '#879da5')
        text.append('\n' + row['observed'].replace('No board process observed', 'No process observed').replace(' observed', ''), style='#81979f')
        self.update(text)


class Workbench(App):
    TITLE = 'IoT Lab'
    CSS_PATH = 'progress.tcss'
    BINDINGS = [Binding('q', 'quit', 'Quit'), Binding('down,j', 'next_board', 'Next board'),
                Binding('up,k', 'previous_board', 'Previous board'), Binding('r', 'check', 'Check now'),
                Binding('f', 'follow', 'Auto-follow'), Binding('1', "view('pcb')", 'PCB', show=False),
                Binding('2', "view('sch')", 'Schematic', show=False), Binding('3', "view('route')", 'Router', show=False),
                Binding('4', "view('3d')", '3D', show=False), Binding('plus,equals', 'zoom(1)', 'Zoom in', show=False),
                Binding('minus', 'zoom(-1)', 'Zoom out', show=False), Binding('0', 'fit', 'Fit', show=False),
                Binding('left', 'rotate(-1)', 'Rotate left', show=False), Binding('right', 'rotate(1)', 'Rotate right', show=False),
                Binding('space', 'spin', 'Spin 3D', show=False),
                Binding('w', "tab('work')", 'Work', show=False), Binding('c', "tab('changes')", 'Changes', show=False),
                Binding('h', "tab('history')", 'History', show=False)]

    def __init__(self, dashboard, image_protocol='auto', follow=True):
        super().__init__()
        self.dashboard = dashboard
        self.rows = []
        self.stage = Stage()
        self.board_ids = tuple(self.stage.boards)
        self.selected = self.board_ids[0]
        self.follow = follow
        self.initializing = True
        self.mode, self.layer, self.side, self.rotation = 'pcb', 'all', 'iso', 45
        self.image_class = dict(auto=Image, tgp=TGPImage, sixel=SixelImage, halfcell=HalfcellImage)[image_protocol]
        self.image_protocol = image_protocol
        self.render_key = None
        self.source_image = None
        self.zoom = 1
        self.pan = (.5, .5)
        self.sheet = 0
        self.threads = []
        self.gpu = None
        self.model_path = None
        self.gpu_failed = False
        self.pitch = 45
        self.drag = None
        self.spinning = False

    def compose(self) -> ComposeResult:
        with Horizontal(id='masthead'):
            yield Static('[b]IoT LAB[/b]  [#80979f]/ LIVE WORKBENCH[/]', id='brand')
            yield Static('Connecting...', id='connection')
        with Horizontal(id='workspace'):
            with VerticalScroll(id='sidebar'):
                yield Label('BOARDS', classes='eyebrow')
                for board in self.board_ids:
                    yield BoardCard(board)
                yield Static('Tab / arrows: board\n1 PCB  2 schematic\n3 router  4 model\nf auto-follow', id='sidebar-help')
            with Vertical(id='detail'):
                yield Static(self.selected, id='selection')
                yield Static('Reading board state...', id='freshness')
                with Horizontal(id='metrics'):
                    yield Static('', id='open-count', classes='metric')
                    yield Static('', id='error-count', classes='metric')
                    yield Static('', id='parity-count', classes='metric')
                with Horizontal(id='view-toolbar'):
                    yield Button('1 PCB', id='view-pcb')
                    yield Button('2 Sch', id='view-sch')
                    yield Button('3 Router', id='view-route')
                    yield Button('4 3D', id='view-3d')
                    yield Button('Following', id='follow-button')
                with Horizontal(id='view-options'):
                    yield Select([('Front + back', 'all'), ('Front copper', 'front'), ('Back copper', 'back'), ('Inner copper', 'inner')], value='all', allow_blank=False, id='layer-select')
                    yield Select([('Isometric', 'iso'), ('Top', 'top'), ('Bottom', 'bottom')], value='iso', allow_blank=False, id='side-select')
                    yield Button('<', id='rotate-left')
                    yield Button('>', id='rotate-right')
                    yield Button('Fit', id='fit-button')
                    yield Button('Next sheet', id='next-sheet')
                    yield Static('', id='render-status', markup=False)
                with Container(id='visual-stage'):
                    yield self.image_class(id='board-image')
                    yield Static('Preparing the latest saved board...', id='visual-empty', markup=False)
                yield Static('Hot reload / waiting for first render', id='source-caption', markup=False)
                with TabbedContent(initial='work', id='details-tabs'):
                    with TabPane('Work', id='work'):
                        with VerticalScroll():
                            yield Label('CURRENT TASK', classes='eyebrow')
                            yield Static('Waiting for activity...', id='task', markup=False)
                            yield Label('OBSERVED ACTIVITY', classes='eyebrow')
                            yield Static('', id='observed', markup=False)
                            yield Static('', id='check-status', markup=False)
                            yield Static('', id='route-log', markup=False)
                    with TabPane('Changes', id='changes'):
                        with VerticalScroll():
                            yield Static('', id='changed-files', markup=False)
                    with TabPane('History', id='history'):
                        with VerticalScroll():
                            yield Label('OPEN CONNECTIONS / RECENT SAMPLES', classes='eyebrow')
                            yield Static('', id='trend', markup=False)
                            yield Label('RECENT COMMITS', classes='eyebrow')
                            yield Static('', id='commits', markup=False)
                yield Static('Drag: orbit 3D / scroll: zoom / Space: spin / 0: fit / candidate != validated', id='footnote')
        yield Footer()

    def on_mount(self):
        self.theme = 'textual-dark'
        self.query_one(BoardCard).focus()
        self.call_after_refresh(self.finish_mount)
        for target in (self.stage.watcher, self.stage.renderer, self.stage.renderer):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self.threads.append(thread)
        self.load_rows()
        self.set_interval(2, self.load_rows)
        self.set_interval(1, self.update_clock)
        self.set_interval(1, self.load_visual)
        self.update_view_controls()
        self.gpu = GPUWorker(self.gpu_callback)
        self.set_interval(1/20, self.spin_tick)

    def finish_mount(self):
        self.initializing = False

    def on_unmount(self):
        self.stage.close()
        if self.gpu:
            self.gpu.close()

    def on_resize(self, event):
        self.set_class(event.size.width < 110 or event.size.height < 40, 'compact')

    @work(thread=True, exclusive=True)
    def load_rows(self):
        try:
            rows = self.dashboard.model()
            self.call_from_thread(self.accept_rows, rows)
        except Exception as exc:
            self.call_from_thread(self.notify, str(exc), severity='error', title='Could not refresh boards')

    def accept_rows(self, rows):
        self.rows = rows
        for row in rows:
            self.query_one('#card-' + row['board'].lower(), BoardCard).refresh_row(row)
        with self.stage.lock:
            boards = list(self.stage.state['boards'])
        for board in boards:
            if board['id'] not in [r['board'] for r in rows]:
                self.query_one('#card-' + board['id'].lower(), BoardCard).refresh_row(dict(board=board['id'], counts=board['counts'] or ('?', '?', '?'), dirty=board['dirty'], observed=board['observed'] or 'No board process observed'))
        if self.follow and boards:
            latest = max(boards, key=lambda b: b['activityTime'])
            if latest['id'] != self.selected or latest['view'] != self.mode:
                self.set_view(latest['view'])
                self.select_board(latest['id'])
        self.select_board(self.selected)

    def update_clock(self):
        label = 'CACHED' if self.dashboard.cached else 'LIVE'
        protocol = self.image_class._Renderable.__module__.rsplit('.', 1)[-1].upper()
        self.query_one('#connection', Static).update(Text(f'{protocol} / {label} / {time.strftime("%H:%M:%S")}', style='#8ab8a6'))
        with self.dashboard.lock:
            checking, due = self.dashboard.checking, self.dashboard.next_check
        text = 'History only; no DRC jobs started.' if self.dashboard.cached else f'Checking {checking}...' if checking else f'Next DRC in {progress.age(due-time.time())} / activity refreshes every 2s'
        self.query_one('#check-status', Static).update(text)

    def select_board(self, board, pin=False):
        if pin:
            self.follow = False
        if board != self.selected:
            self.render_key, self.source_image, self.zoom, self.sheet = None, None, 1, 0
            self.query_one('#board-image').image = None
            self.model_path = None
            self.pan = (.5, .5)
        self.selected = board
        for card in self.query(BoardCard):
            card.set_class(card.board == board, 'selected')
        if not self.rows:
            return
        row = next((x for x in self.rows if x['board'] == board), None)
        if row is None:
            row = dict(board=board, counts=('?', '?', '?'), freshness='No DRC sample in the progress log', activity='Watching saved files', observed='No current observation', saved='?', error=None, changed=[], trend='No samples', commits=[])
        self.query_one('#selection', Static).update(Text(board, style='bold #f1eee7'))
        self.query_one('#freshness', Static).update(Text(row['freshness'], style='#bba489'))
        for id_, title, value in zip(('open-count', 'error-count', 'parity-count'), ('OPEN CONNECTIONS', 'DRC ERRORS', 'PARITY'), row['counts']):
            color = '#e9b789' if id_ == 'open-count' else '#e09a89' if isinstance(value, int) and value else '#8fc7b3'
            self.query_one('#' + id_, Static).update(Text.assemble((str(value) + '  ', 'bold ' + color), (title, '#859ba4')))
        self.query_one('#task', Static).update(row['activity'])
        self.query_one('#observed', Static).update(row['observed'] + '\nPCB saved ' + row['saved'] + ' ago' + ('\nCheck failed: ' + row['error'] if row['error'] else ''))
        self.query_one('#changed-files', Static).update('\n'.join(row['changed']) or 'No uncommitted files in this board folder.')
        self.query_one('#trend', Static).update(row['trend'])
        self.query_one('#commits', Static).update('\n\n'.join(row['commits']) or 'No board commits yet.')
        self.update_view_controls()

    def action_next_board(self):
        index = (self.board_ids.index(self.selected) + 1) % len(self.board_ids)
        self.query_one('#card-' + self.board_ids[index].lower()).focus()

    def action_previous_board(self):
        index = (self.board_ids.index(self.selected) - 1) % len(self.board_ids)
        self.query_one('#card-' + self.board_ids[index].lower()).focus()

    def action_tab(self, tab):
        self.add_class('show-details')
        self.query_one(TabbedContent).active = tab

    def action_check(self):
        if self.dashboard.cached:
            self.notify('Restart without --cached to run DRC.', title='History view')
        else:
            self.dashboard.refresh.set()
            self.notify('A fresh DRC sweep is queued.', title='Check requested')

    def set_view(self, mode):
        if mode != self.mode:
            self.mode = mode
            self.render_key, self.source_image, self.zoom, self.sheet = None, None, 1, 0
            self.query_one('#board-image').image = None
            self.model_path = None
            self.pan = (.5, .5)
        self.update_view_controls()

    def action_view(self, mode):
        self.remove_class('show-details')
        self.follow = False
        self.set_view(mode)
        self.load_visual()

    def action_follow(self):
        self.follow = not self.follow
        self.update_view_controls()
        self.load_rows()

    def update_view_controls(self):
        self.query_one('#follow-button', Button).label = 'Following' if self.follow else 'Follow'
        for mode in ('pcb', 'sch', 'route', '3d'):
            self.query_one('#view-' + mode).set_class(mode == self.mode, 'active-view')
        self.query_one('#layer-select').display = self.mode in ('pcb', 'route')
        for id_ in ('side-select', 'rotate-left', 'rotate-right'):
            self.query_one('#' + id_).display = self.mode == '3d'
        self.query_one('#next-sheet').display = self.mode == 'sch'

    @work(thread=True, exclusive=True, group='visual')
    def load_visual(self):
        identity = (self.selected, self.mode, self.layer, self.side, self.rotation)
        try:
            if self.mode == '3d' and not self.gpu_failed:
                result = self.stage.request(self.selected, 'model')
            else:
                # Static fallback only needs discrete angles if GPU setup is unavailable.
                result = self.stage.request(self.selected, self.mode, self.layer, self.side, int(round(self.rotation/45)*45)%360)
            self.call_from_thread(self.accept_visual, identity, result)
        except Exception as exc:
            self.call_from_thread(self.visual_error, str(exc))

    def visual_error(self, message):
        self.query_one('#render-status', Static).update(message)

    def accept_visual(self, identity, result):
        if identity != (self.selected, self.mode, self.layer, self.side, self.rotation):
            return
        ready = result if result['status'] == 'ready' else result.get('previous')
        if ready and self.render_key != ready['key']:
            self.render_key = ready['key']
            self.assets = ready['assets']
            self.sheet = min(self.sheet, len(self.assets) - 1)
            if self.mode == '3d' and not self.gpu_failed:
                self.model_path = self.assets[0]
                self.request_gpu()
            else:
                self.source_image = PILImage.open(self.assets[self.sheet]).convert('RGB')
                self.show_image()
            label = 'ROUTER CANDIDATE / NOT VALIDATED' if self.mode == 'route' else 'SAVED ' + ('SCHEMATIC' if self.mode == 'sch' else 'BOARD')
            self.query_one('#source-caption', Static).update(f'{label} / source {time.strftime("%H:%M:%S", time.localtime(ready["sourceTime"]))} / render {time.strftime("%H:%M:%S", time.localtime(ready["rendered"]))}')
        self.query_one('#visual-empty').display = self.source_image is None
        status = ('GPU model loaded' if self.mode == '3d' and not self.gpu_failed else 'Live / latest save') if result['status'] == 'ready' else 'Updating view...' if result['status'] in ('queued', 'rendering') else result.get('message', 'Waiting for router')
        self.query_one('#render-status', Static).update(status)
        if self.source_image is None:
            self.query_one('#visual-empty', Static).update(status + ('\n3D exports can take a moment.' if self.mode == '3d' else ''))
        with self.stage.lock:
            board = next((b for b in self.stage.state['boards'] if b['id'] == self.selected), None)
        if board and board.get('route'):
            self.query_one('#route-log', Static).update('\n'.join(board['route']['logLines'][-6:]))

    def show_image(self):
        if self.source_image is None:
            return
        image = self.source_image
        if self.zoom > 1:
            width, height = image.size
            crop_w, crop_h = width / self.zoom, height / self.zoom
            x = max(crop_w/2, min(width-crop_w/2, self.pan[0]*width))
            y = max(crop_h/2, min(height-crop_h/2, self.pan[1]*height))
            image = image.crop((x-crop_w/2, y-crop_h/2, x+crop_w/2, y+crop_h/2))
        self.query_one('#board-image').image = image

    def action_zoom(self, direction):
        self.zoom = max(1, min(12, self.zoom * (1.25 if direction > 0 else .8)))
        if self.mode == '3d' and not self.gpu_failed:
            self.request_gpu()
        else:
            self.show_image()

    def action_fit(self):
        self.zoom = 1
        self.pan = (.5, .5)
        if self.mode == '3d' and not self.gpu_failed:
            self.rotation, self.pitch = 45, 45
            self.request_gpu()
        else:
            self.show_image()

    def action_rotate(self, direction):
        if self.mode == '3d':
            self.rotation = (self.rotation + direction * 10) % 360
            self.side = 'iso'
            self.request_gpu() if not self.gpu_failed else self.load_visual()

    def action_spin(self):
        if self.mode == '3d' and not self.gpu_failed:
            self.spinning = not self.spinning

    def spin_tick(self):
        if self.spinning and self.mode == '3d' and self.model_path:
            self.rotation = (self.rotation + 1.5) % 360
            self.request_gpu()

    def request_gpu(self):
        if not self.gpu or not self.model_path:
            return
        size = self.query_one('#visual-stage').size
        pitch = 89.9 if self.side == 'top' else -89.9 if self.side == 'bottom' else self.pitch
        self.gpu.request(self.model_path, self.model_path, yaw=self.rotation, pitch=pitch, zoom=self.zoom,
                         width=min(1200,max(400,size.width*10)), height=min(900,max(240,size.height*20)))

    def gpu_callback(self, token, image, device, duration, error):
        if not self.stage.stop.is_set():
            self.post_message(GPUFrame(token, image, device, duration, error))

    def on_gpuframe(self, event: GPUFrame):
        self.accept_gpu(*event.values)

    def accept_gpu(self, token, image, device, duration, error):
        if self.mode != '3d' or token != self.model_path:
            return
        if error:
            self.gpu_failed = True
            self.render_key = None
            self.notify('GPU renderer unavailable; using KiCad images. ' + error, severity='warning')
            self.load_visual()
            return
        self.source_image = image
        self.query_one('#board-image').image = image
        self.query_one('#visual-empty').display = False
        self.query_one('#render-status', Static).update(f'{device} / {duration*1000:.0f}ms GPU frame')

    def pointer_target(self, event):
        """Driver events may lack a widget even after bubbling through the screen."""
        if self.mouse_captured is not None:
            return self.mouse_captured
        if event.widget is not None:
            return event.widget
        try:
            return self.get_widget_at(event.screen_x, event.screen_y)[0]
        except NoWidget:
            return None

    def on_mouse_down(self, event):
        target = self.pointer_target(event)
        if target is not None and target.id == 'board-image' and event.button == 1:
            self.drag = (event.screen_x, event.screen_y, self.rotation, self.pitch, self.pan)
            target.capture_mouse()
            self.spinning = False
            event.stop()

    def on_mouse_move(self, event):
        if self.drag and self.mode == '3d':
            x, y, yaw, pitch, _ = self.drag
            self.rotation = (yaw + (event.screen_x-x)*2) % 360
            self.pitch = max(-89.9, min(89.9,pitch+(event.screen_y-y)*3))
            self.side = 'iso'
            self.request_gpu()
        elif self.drag:
            x, y, _, _, pan = self.drag
            size = self.query_one('#visual-stage').size
            self.pan = (max(0,min(1,pan[0]-(event.screen_x-x)/max(1,size.width*self.zoom))),
                        max(0,min(1,pan[1]-(event.screen_y-y)/max(1,size.height*self.zoom))))
            self.show_image()

    def on_mouse_up(self, event):
        if self.drag:
            self.drag = None
            if self.mouse_captured is not None:
                self.mouse_captured.release_mouse()
            event.stop()

    def on_mouse_scroll_up(self, event):
        target = self.pointer_target(event)
        if target is not None and target.id == 'board-image':
            self.action_zoom(1)
            event.stop()

    def on_mouse_scroll_down(self, event):
        target = self.pointer_target(event)
        if target is not None and target.id == 'board-image':
            self.action_zoom(-1)
            event.stop()

    def on_select_changed(self, event: Select.Changed):
        if event.select.id == 'layer-select':
            self.layer = str(event.value)
        elif event.select.id == 'side-select':
            self.side = str(event.value)
            if self.mode == '3d' and not self.gpu_failed:
                self.request_gpu()
                return
        self.load_visual()

    def on_button_pressed(self, event: Button.Pressed):
        id_ = event.button.id or ''
        if id_.startswith('view-'):
            self.action_view(id_[5:])
        elif id_ == 'follow-button':
            self.action_follow()
        elif id_ == 'fit-button':
            self.action_fit()
        elif id_ in ('rotate-left', 'rotate-right'):
            self.action_rotate(-1 if id_ == 'rotate-left' else 1)
        elif id_ == 'next-sheet' and getattr(self, 'assets', None):
            self.sheet = (self.sheet + 1) % len(self.assets)
            self.source_image = PILImage.open(self.assets[self.sheet]).convert('RGB')
            self.show_image()
