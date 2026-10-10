"""Owned process fixtures; no KiCad, router, daemon or unrelated PID mutation."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import lean_owned as owned
import lean_workflow as lean


class OwnedStageTests(unittest.TestCase):
    def test_admission_delay_cannot_extend_absolute_deadline_or_release_work(self):
        real=owned.prepare
        deadline=lean.deadline_after(.05,{})
        def delayed(*args):
            proc=real(*args)
            threading.Event().wait(max(0,deadline-lean.now())+.01)
            return proc
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/'work'
            with mock.patch.object(owned,'prepare',side_effect=delayed):
                with self.assertRaises(subprocess.TimeoutExpired) as caught:
                    lean.run_stage([sys.executable,'-c','import pathlib;pathlib.Path('+repr(str(marker))+').touch()'],
                        stage='expired-admission',deadline=deadline)
            self.assertFalse(marker.exists())
            self.assertTrue(caught.exception.cleanup['complete'])

    def test_nested_expired_activation_preserves_timeout_and_never_executes(self):
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/'work'
            code=('import os,sys,time,subprocess,lean_owned as o,lean_workflow as l; '
                  'd=l.deadline_after(.05,{}); '
                  'p=o.prepare([sys.executable,"-c",'+repr('import pathlib;pathlib.Path('+repr(str(marker))+').touch()')+'], '
                  '{"env":dict(os.environ,IOT_LEAN_DEADLINE=l.encode_deadline(d))}); '
                  'time.sleep(max(0,d-l.now())+.01)\n'
                  'try:p.activate();raise AssertionError("expired activation accepted")\n'
                  'except subprocess.TimeoutExpired:print("timeout preserved")\n'
                  'finally:assert p.cleanup()["complete"]')
            result=lean.run_stage([sys.executable,'-c',code],stage='nested-deadline',deadline=lean.deadline_after(3,{}),
                env=dict(os.environ,PYTHONPATH=str(Path(owned.__file__).parent)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip(),'timeout preserved')
            self.assertFalse(marker.exists())

    def test_linux_native_state_parser_rejects_unknown_and_mismatched_pid(self):
        self.assertEqual(owned._proc_state('123 (name with ) bracket) S 1 123 1'),(123,123,'S'))
        with self.assertRaises(ValueError):owned._proc_state('123 (name) Q 1 123')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'123').mkdir();(root/'123'/'stat').write_text('456 (name) S 1 123')
            real=Path
            def path(value):return root if value=='/proc' else real(value)
            with mock.patch.object(owned.sys,'platform','linux'),mock.patch.object(owned,'Path',side_effect=path):
                with self.assertRaises(ValueError):owned._live_members(123,123)

    def test_darwin_malformed_process_rows_fail_closed(self):
        rows=subprocess.CompletedProcess([],0,stdout='bad row\n',stderr='')
        with mock.patch.object(owned.sys,'platform','darwin'),mock.patch.object(subprocess,'run',return_value=rows):
            with self.assertRaises(ValueError):owned._live_members(123,123)

    def test_darwin_unknown_exiting_status_stays_conservatively_live(self):
        rows=subprocess.CompletedProcess([],0,stdout='123 123 ?E\n',stderr='')
        with mock.patch.object(owned.sys,'platform','darwin'),mock.patch.object(subprocess,'run',return_value=rows):
            self.assertEqual(owned._live_members(123,999),[123])

    def test_primary_error_survives_uncertain_broker_close(self):
        real=owned.Process.close
        def close(proc):real(proc);return False
        with mock.patch.object(owned.Process,'close',close):
            with self.assertRaises(FileNotFoundError):
                lean.run_stage(['/nonexistent/owned-primary-error'],stage='primary')

    def test_nested_relative_cwd_uses_controller_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'subdir').mkdir()
            code=('import lean_workflow as l,sys,subprocess; '
                  'p=l.run_stage([sys.executable,"-c","import os;print(os.getcwd())"],stage="relative", '
                  'cwd="subdir",stdout=subprocess.PIPE,text=True);print(p.stdout.strip())')
            result=lean.run_stage([sys.executable,'-c',code],stage='controller-cwd',cwd=root,
                env=dict(os.environ,PYTHONPATH=str(Path(owned.__file__).parent)),stdout=subprocess.PIPE,text=True)
            self.assertEqual(result.returncode,0)
            self.assertEqual(result.stdout.strip(),str((root/'subdir').resolve()))

    def test_request_thread_start_failure_fails_closed_and_closes_descriptors(self):
        real=threading.Thread.start
        def start(thread):
            if thread.name=='owned-stage-request':raise RuntimeError('controlled request-thread failure')
            return real(thread)
        code='import lean_workflow as l,sys;l.run_stage([sys.executable,"-c","pass"],stage="request")'
        with mock.patch.object(threading.Thread,'start',start):
            with self.assertRaisesRegex(RuntimeError,'broker did not settle'):
                lean.run_stage([sys.executable,'-c',code],stage='request-failure',stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                    env=dict(os.environ,PYTHONPATH=str(Path(owned.__file__).parent)))
        self.assertFalse(any(t.name.startswith('owned-stage-') for t in threading.enumerate()))

    def test_spawn_thread_start_failure_closes_owned_scope(self):
        real=threading.Thread.start
        def start(thread):
            if thread.name=='owned-stage-spawn':raise RuntimeError('controlled Thread.start failure')
            return real(thread)
        with mock.patch.object(threading.Thread,'start',start):
            with self.assertRaisesRegex(RuntimeError,'Thread.start failure') as caught:
                lean.run_stage([sys.executable,'-c','raise AssertionError("must never execute")'],stage='thread-failure')
        self.assertTrue(caught.exception.cleanup['complete'])
        self.assertFalse(any(t.name.startswith('owned-stage-') for t in threading.enumerate()))

    def test_signal_during_spawn_thread_start_does_not_release_child_work(self):
        real=threading.Thread.start
        def start(thread):
            if thread.name=='owned-stage-spawn':os.kill(os.getpid(),signal.SIGTERM)
            return real(thread)
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/'work'
            with mock.patch.object(threading.Thread,'start',start):
                with self.assertRaises(lean.StageCancelled) as caught:
                    lean.run_stage([sys.executable,'-c','import pathlib;pathlib.Path('+repr(str(marker))+').touch()'],stage='thread-signal')
            self.assertFalse(marker.exists())
            self.assertTrue(caught.exception.cleanup['complete'])

    def test_admission_cancellation_closes_prepared_descriptors_without_spawn(self):
        real=owned.prepare
        captured=[]
        def prepare(*args):
            proc=real(*args)
            captured.extend(proc.state.fds)
            os.kill(os.getpid(),signal.SIGTERM)
            return proc
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/'work'
            with mock.patch.object(owned,'prepare',side_effect=prepare):
                with self.assertRaises(lean.StageCancelled) as caught:
                    lean.run_stage([sys.executable,'-c','import pathlib;pathlib.Path('+repr(str(marker))+').touch()'],stage='admission')
            self.assertTrue(caught.exception.cleanup['complete'])
            self.assertFalse(marker.exists())
            for fd in captured:
                with self.assertRaises(OSError):os.fstat(fd)

    def test_cancellation_during_pending_spawn_never_releases_work(self):
        real_prepare,real_popen=owned.Scope.prepare,subprocess.Popen
        states=[]
        entered,release=threading.Event(),threading.Event()
        def prepare(scope,*args,**kwargs):
            state=real_prepare(scope,*args,**kwargs)
            states.append(state)
            return state
        def popen(command,*args,**kwargs):
            if any(str(x).endswith('lean_owned_exec.py') for x in command):
                entered.set()
                if not release.wait(5):raise RuntimeError('fixture admission release missing')
            return real_popen(command,*args,**kwargs)
        def cancel():
            if not entered.wait(5):return
            os.kill(os.getpid(),signal.SIGTERM)
            until=time.monotonic()+5
            while states and not states[0].closing and time.monotonic()<until:
                release.wait(.005)
            release.set()
        sender=threading.Thread(target=cancel)
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/'work'
            with mock.patch.object(owned.Scope,'prepare',prepare),mock.patch.object(subprocess,'Popen',side_effect=popen):
                sender.start()
                try:
                    with self.assertRaises(lean.StageCancelled) as caught:
                        lean.run_stage([sys.executable,'-c','import pathlib;pathlib.Path('+repr(str(marker))+').touch()'],stage='pending')
                finally:
                    release.set()
                    sender.join(6)
            self.assertFalse(sender.is_alive())
            self.assertTrue(entered.is_set())
            self.assertFalse(marker.exists())
            self.assertTrue(caught.exception.cleanup['complete'])
            self.assertTrue(states[0].reaped)

    def test_success_cleans_same_group_helper_before_return(self):
        with tempfile.TemporaryDirectory() as folder:
            pidfile=Path(folder)/'helper'
            code=('import os,signal,time,pathlib\nr,w=os.pipe(); p=os.fork()\n'
                  'if p==0:\n os.close(r);signal.signal(signal.SIGTERM,signal.SIG_IGN)\n '
                  'pathlib.Path('+repr(str(pidfile))+').write_text(str(os.getpid()))\n '
                  'os.write(w,b"R");os.close(w);time.sleep(30)\n'
                  'else:\n os.close(w);assert os.read(r,1)==b"R";os.close(r)')
            pid=None
            try:
                result=lean.run_stage([sys.executable,'-c',code],stage='leftover',stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                pid=int(pidfile.read_text())
                self.assertEqual(result.returncode,0)
                with self.assertRaises(ProcessLookupError):os.kill(pid,0)
            finally:
                if pidfile.exists():
                    pid=int(pidfile.read_text())
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass

    def test_cwd_exact_environment_text_binary_and_high_passed_fds(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            first,second=root/'first',root/'second'
            first.write_bytes(b'one');second.write_bytes(b'two')
            with first.open('rb') as a,second.open('rb') as b:
                high=[fcntl.fcntl(a.fileno(),fcntl.F_DUPFD,64),fcntl.fcntl(b.fileno(),fcntl.F_DUPFD,64)]
                try:
                    code=('import os,sys; assert os.getcwd()==sys.argv[1]; '
                          'assert os.environ["ONLY_TEST"]=="exact"; '
                          'assert "HOME" not in os.environ; '
                          'sys.stdout.buffer.write(os.read(int(sys.argv[2]),3)+os.read(int(sys.argv[3]),3)+b"\\r\\n")')
                    for text in (False,True):
                        result=lean.run_stage([sys.executable,'-c',code,str(root.resolve()),*map(str,high)],stage='streams',
                            env={'ONLY_TEST':'exact'},cwd=root,pass_fds=tuple(high),stdout=subprocess.PIPE,text=text)
                        self.assertEqual(result.returncode,0)
                        self.assertEqual(result.stdout,'onetwo\n' if text else b'onetwo\r\n')
                        for fd in high:os.lseek(fd,0,os.SEEK_SET)
                finally:
                    for fd in high:os.close(fd)

    def test_cpu_event_comes_from_owned_leader_wait4(self):
        with tempfile.TemporaryDirectory() as folder:
            event=Path(folder)/'event'
            code='import time; until=time.process_time()+.12\nwhile time.process_time()<until: pass'
            lean.run_stage([sys.executable,'-c',code],stage='cpu',event_file=event)
            row=json.loads(event.read_text())
            self.assertGreater(row['child_cpu_s'],.10)
            self.assertIn('wait4',row['cpu_scope'])

    def test_missing_executable_preserves_spawn_error_and_reaps_bootstrap(self):
        with self.assertRaises(FileNotFoundError) as caught:
            lean.run_stage(['/nonexistent/lean-owned-test-executable'],stage='missing')
        self.assertTrue(caught.exception.cleanup['child_reaped'])

    def test_bootstrap_cyclic_fd_mapping_and_error_target_collision(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'a').write_bytes(b'one');(root/'b').write_bytes(b'two')
            with (root/'a').open('rb') as a,(root/'b').open('rb') as b:
                high=[fcntl.fcntl(a.fileno(),fcntl.F_DUPFD,64),fcntl.fcntl(b.fileno(),fcntl.F_DUPFD,64)]
                try:
                    for collision in (False,True):
                        ready,approve=os.pipe();error_read,error_write=os.pipe()
                        try:
                            os.write(approve,b'G');os.close(approve);approve=None
                            mappings=[[high[0],high[1]],[high[1],high[0]]]
                            if collision:mappings.append([error_write,high[0]])
                            command=('/nonexistent/lean-owned-collision' if collision else sys.executable)
                            args=[] if collision else ['-c','import os,sys;sys.stdout.buffer.write(os.read(int(sys.argv[1]),3)+os.read(int(sys.argv[2]),3))',*map(str,high)]
                            result=lean.run_stage([sys.executable,str(Path(owned.__file__).with_name('lean_owned_exec.py')),
                                str(ready),str(error_write),json.dumps(mappings),command,*args],stage='fd-cycle',
                                pass_fds=(ready,error_write,*high),stdout=subprocess.PIPE)
                            os.close(error_write);error_write=None
                            detail=os.read(error_read,4096)
                            if collision:
                                self.assertEqual(result.returncode,127)
                                self.assertEqual(json.loads(detail)['type'],'FileNotFoundError')
                            else:
                                self.assertEqual(result.returncode,0)
                                self.assertEqual(result.stdout,b'twoone')
                                self.assertEqual(detail,b'')
                        finally:
                            for fd in (ready,approve,error_read,error_write):
                                if fd is not None:os.close(fd)
                        for fd in high:os.lseek(fd,0,os.SEEK_SET)
                finally:
                    for fd in high:os.close(fd)

    def test_foreign_lineage_cannot_use_real_capability(self):
        scope=owned.Scope()
        proc=None
        try:
            options,fds=owned._options({'stdout':subprocess.PIPE})
            state=scope.prepare([sys.executable,'-c','import time;time.sleep(30)'],options,fds)
            proc=owned.Process(state,scope);proc.start()
            until=time.monotonic()+3
            while not state.proc and time.monotonic()<until:time.sleep(.005)
            self.assertIsNotNone(state.proc)
            with self.assertRaisesRegex(ValueError,'lineage'):
                owned._rpc(scope.path,dict(op='spawn',cap=state.handle,command=['false'],options={}))
        finally:
            if proc:proc.cleanup()
            self.assertTrue(scope.close())

    def test_collector_failure_cleans_registered_descendant(self):
        with tempfile.TemporaryDirectory() as folder:
            pidfile=Path(folder)/'helper'
            helper=('import os,pathlib,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);'
                    'pathlib.Path('+repr(str(pidfile))+').write_text(str(os.getpid()));time.sleep(30)')
            controller='import lean_workflow as l,sys;l.run_stage([sys.executable,"-c",'+repr(helper)+'],stage="helper")'
            real=owned.Scope._read
            injected=threading.Event()
            def read(selector,output,timeout):
                if selector.get_map() and pidfile.exists() and not injected.is_set():
                    injected.set()
                    raise RuntimeError('controlled collector failure')
                return real(selector,output,timeout)
            try:
                with mock.patch.object(owned.Scope,'_read',staticmethod(read)):
                    with self.assertRaisesRegex(RuntimeError,'collector failure'):
                        lean.run_stage([sys.executable,'-c',controller],stage='controller',stdout=subprocess.PIPE,
                            env=dict(os.environ,PYTHONPATH=str(Path(owned.__file__).parent)))
                self.assertTrue(injected.is_set())
                with self.assertRaises(ProcessLookupError):os.kill(int(pidfile.read_text()),0)
            finally:
                if pidfile.exists():
                    try:os.killpg(int(pidfile.read_text()),signal.SIGKILL)
                    except ProcessLookupError:pass


if __name__=='__main__':unittest.main()
