"""Root-owned local stage groups, including helpers of stopped controllers.

Only the root broker creates processes. Nested controllers receive capabilities
bound to their existing owned group, never authority to signal arbitrary PIDs.
The registry is in the root process; its thread survives nested SIGSTOP/KILL.
"""
import array
import base64
import ctypes
import json
import locale
import math
import os
from pathlib import Path
import selectors
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid

SOCKET_ENV = 'IOT_LEAN_BROKER_SOCKET'
HANDLE_ENV = 'IOT_LEAN_STAGE_HANDLE'
DEPTH_ENV = 'IOT_LEAN_STAGE_DEPTH'
MAX_FRAME = 128*1024*1024
MAX_FDS = 16
MAX_STAGES = 256
MAX_CONNECTIONS = 32
_adoption_lock=threading.RLock()
_adoption_scopes=0
_adoption_prior=None


def _subreaper(acquire):
    """Linux process-local adoption, restored after the last settled scope.

    No global daemon setting and no waitpid(-1). This CLI root must exclusively
    own its broker children; foreign groups are never reaped by this module.
    """
    global _adoption_scopes,_adoption_prior
    if sys.platform!='linux':return
    libc=ctypes.CDLL(None,use_errno=True)
    with _adoption_lock:
        if acquire:
            if not _adoption_scopes:
                prior=ctypes.c_int()
                if libc.prctl(37,ctypes.byref(prior),0,0,0):
                    raise OSError(ctypes.get_errno(),'child-adoption runtime unavailable')
                if libc.prctl(36,1,0,0,0):
                    raise OSError(ctypes.get_errno(),'child-adoption admission denied')
                _adoption_prior=prior.value
            _adoption_scopes+=1
        else:
            if _adoption_scopes==1:
                if libc.prctl(36,_adoption_prior,0,0,0):
                    raise OSError(ctypes.get_errno(),'child-adoption restoration failed')
                _adoption_prior=None
            _adoption_scopes-=1


def _reap_adopted(state,deadline):
    if sys.platform!='linux':return
    # The group's leader is still held unreaped, reserving this group identity.
    # Only its nonleader zombies which the kernel adopted to THIS process are
    # eligible. Never reap another registered leader or an arbitrary child.
    for entry in Path('/proc').iterdir():
        if time.monotonic()>=deadline:raise TimeoutError('owned adoption budget exhausted')
        if not entry.name.isdigit():continue
        try:line=(entry/'stat').read_text()
        except FileNotFoundError:continue
        pid,group,status=_proc_state(line)
        if pid!=int(entry.name):raise ValueError('native process state PID mismatched')
        parent=int(line.rpartition(')')[2].split()[1])
        if pid!=state.proc.pid and group==state.proc.pid and parent==os.getpid() and status=='Z':
            try:reaped,_,usage=os.wait4(pid,os.WNOHANG)
            except ChildProcessError:continue
            if reaped:
                state.adopted_child_cpu_s+=usage.ru_utime+usage.ru_stime
                state.adopted_children+=1


def _peer(sock):
    if sys.platform == 'linux' and hasattr(socket, 'SO_PEERCRED'):
        pid, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return pid, uid
    if sys.platform == 'darwin':
        pid = struct.unpack('i', sock.getsockopt(0, 2, 4))[0]  # LOCAL_PEERPID
        libc = ctypes.CDLL(None, use_errno=True)
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        if libc.getpeereid(sock.fileno(), ctypes.byref(uid), ctypes.byref(gid)):
            raise OSError(ctypes.get_errno(), 'peer identity unavailable')
        return pid, uid.value
    raise ValueError('owned stages require supported local peer credentials')


def _peek_exit(pid):
    """WNOWAIT holds our direct child's PID identity until the final reap."""
    libc = ctypes.CDLL(None, use_errno=True)
    waitid = libc.waitid
    waitid.argtypes = (ctypes.c_int, ctypes.c_uint, ctypes.c_void_p, ctypes.c_int)
    waitid.restype = ctypes.c_int
    # siginfo_t begins with signo/errno/code on the two supported platforms;
    # the oversized aligned buffer avoids depending on platform union layout.
    info = ctypes.create_string_buffer(1024)
    if waitid(os.P_PID, pid, ctypes.byref(info), os.WEXITED|os.WNOHANG|os.WNOWAIT):
        raise OSError(ctypes.get_errno(), 'owned-child waitid failed')
    # Darwin reports CLD_STOPPED even with WEXITED requested. A stop notification
    # must never authorize blocking wait4/reap: only terminal CLD_* states do.
    return (ctypes.c_int*3).from_buffer(info)[2] in (1,2,3)


def _runtime():
    for name in ('wait4', 'WNOWAIT', 'WEXITED', 'WNOHANG', 'P_PID'):
        if not hasattr(os, name):
            raise ValueError('owned stages require native non-reaping wait support')
    ctypes.CDLL(None).waitid
    if sys.platform=='linux':
        pid,group,_=_proc_state(Path('/proc/self/stat').read_text())
        if pid!=os.getpid() or group!=os.getpgrp():raise ValueError('native process state probe mismatched')
    elif sys.platform=='darwin' and not os.access('/bin/ps',os.X_OK):
        raise ValueError('owned stages require native group-state inspection')
    left, right = socket.socketpair()
    try:
        pid, uid = _peer(left)
        if pid != os.getpid() or uid != os.getuid():
            raise ValueError('local peer identity probe failed')
    finally:
        left.close()
        right.close()


def _exact(sock, size):
    out = bytearray()
    while len(out)<size:
        chunk = sock.recv(size-len(out))
        if not chunk:
            raise OSError('owned-stage connection closed')
        out.extend(chunk)
    return bytes(out)


def _send(sock, message, fds=()):
    data = json.dumps(message, separators=(',', ':')).encode()
    if len(data)>MAX_FRAME or len(fds)>MAX_FDS:
        raise ValueError('owned-stage frame/descriptor bound exceeded')
    packet = struct.pack('!I', len(data))+data
    ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', fds))] if fds else []
    sent = sock.sendmsg([packet], ancillary)
    if sent<len(packet):sock.sendall(packet[sent:])


def _receive(sock):
    fds = []
    try:
        header, ancillary, flags, _ = sock.recvmsg(4, socket.CMSG_SPACE(MAX_FDS*4))
        for level, kind, data in ancillary:
            if level != socket.SOL_SOCKET or kind != socket.SCM_RIGHTS:
                raise ValueError('unexpected owned-stage ancillary data')
            values = array.array('i')
            values.frombytes(data[:len(data)-len(data)%values.itemsize])
            fds.extend(values)
        if flags & socket.MSG_CTRUNC or len(fds)>MAX_FDS:
            raise ValueError('truncated/excessive owned-stage descriptors')
        header += _exact(sock, 4-len(header))
        size = struct.unpack('!I', header)[0]
        if not size or size>MAX_FRAME:
            raise ValueError('invalid owned-stage frame size')
        return json.loads(_exact(sock, size)), fds
    except BaseException:
        for fd in fds:
            os.close(fd)
        raise


def _proc_state(line):
    # comm is parenthesized and may contain spaces or ')'; the final ')' is
    # followed by fixed numeric/status fields. Never infer from process names.
    before,separator,after=line.rpartition(')')
    pid=before.split('(',1)[0].strip()
    fields=after.split()
    if (not separator or not pid.isdigit() or len(fields)<3 or fields[0] not in set('RSDZTtXxKWPI')
            or not fields[1].isdigit() or not fields[2].isdigit()):
        raise ValueError('malformed native process-group state')
    return int(pid),int(fields[2]),fields[0]


def _live_members(pgid, leader, deadline=None, include_zombies=False):
    deadline=time.monotonic()+1 if deadline is None else deadline
    if time.monotonic()>=deadline:raise TimeoutError('native group-state budget exhausted')
    # The leader is still our unreaped direct child. A new-session group cannot
    # acquire foreign-session members. ps is inspection, never a PID selector
    # authorizing signals: all signals use that held leader's actual group.
    if sys.platform=='linux':
        members=[]
        for entry in Path('/proc').iterdir():
            if time.monotonic()>=deadline:raise TimeoutError('native group-state budget exhausted')
            if not entry.name.isdigit():continue
            try:pid,group,status=_proc_state((entry/'stat').read_text())
            except FileNotFoundError:continue  # Concurrently exited process.
            if pid!=int(entry.name):raise ValueError('native process state PID mismatched')
            if group==pgid and pid!=leader and (include_zombies or status not in ('Z','X','x')):members.append(pid)
        return members
    rows = subprocess.run(['/bin/ps', '-axo', 'pid=,pgid=,stat='], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, timeout=max(.001,deadline-time.monotonic()))
    if rows.returncode:
        raise OSError('owned-group membership unavailable')
    members = []
    for line in rows.stdout.splitlines():
        fields = line.split()
        if not fields:continue
        if len(fields)==3 and fields[0].isdigit() and fields[1].isdigit() and fields[2][0] in 'RSDZTtXxKWPIU?':
            pid, group = int(fields[0]), int(fields[1])
            if group == pgid and pid != leader and (include_zombies or not fields[2].startswith('Z')):
                members.append(pid)
        else:raise ValueError('malformed native process-group state: '+repr(line))
    return members


def _options(kwargs, duplicate=True):
    allowed = {'stdin','stdout','stderr','cwd','env','text','universal_newlines',
               'encoding','errors','bufsize','restore_signals','pass_fds','close_fds'}
    if set(kwargs)-allowed or kwargs.get('close_fds', True) is not True:
        raise ValueError('unsupported owned-stage subprocess option')
    options, fds = dict(kwargs), []
    cwd=options.get('cwd')
    cwd=os.getcwd() if cwd is None else os.fspath(cwd)
    options['cwd'] = os.path.abspath(cwd) if cwd else cwd
    options['env'] = dict(options.get('env', os.environ))
    try:
        for number,key in enumerate(('stdin','stdout','stderr')):
            value = options.get(key)
            if value is None:value=number
            if isinstance(value, int) and value<0:
                continue
            fd = value if isinstance(value, int) else value.fileno()
            options[key] = {'fd':len(fds)}
            fds.append(os.dup(fd) if duplicate else fd)
        mappings = []
        for fd in options.pop('pass_fds', ()):
            if not isinstance(fd, int) or fd<3:
                raise ValueError('invalid explicitly passed descriptor')
            mappings.append([fd,len(fds)])
            fds.append(os.dup(fd) if duplicate else fd)
        options['passed'] = mappings
        if len(fds)>MAX_FDS:
            raise ValueError('owned-stage descriptor bound exceeded')
    except BaseException:
        if duplicate:
            for fd in fds:os.close(fd)
        raise
    return options, fds


def _decoded(data, options):
    if data is None:
        return None
    value = base64.b64decode(data)
    if options.get('text') or options.get('universal_newlines') or options.get('encoding'):
        return value.decode(options.get('encoding') or locale.getpreferredencoding(False),
                            options.get('errors') or 'strict').replace('\r\n','\n').replace('\r','\n')
    return value


def _validate_options(options, fd_count):
    allowed={'stdin','stdout','stderr','cwd','env','text','universal_newlines',
             'encoding','errors','bufsize','restore_signals','close_fds','passed'}
    if not isinstance(options,dict) or set(options)-allowed:
        raise ValueError('unsupported owned-stage wire options')
    if (not isinstance(options.get('cwd'),str)
            or not isinstance(options.get('env'),dict)
            or not all(isinstance(k,str) and isinstance(v,str) for k,v in options['env'].items())):
        raise ValueError('invalid owned-stage cwd/environment')
    roles=[]
    for key in ('stdin','stdout','stderr'):
        value=options.get(key)
        if isinstance(value,dict):
            if set(value)!={'fd'} or type(value['fd']) is not int:
                raise ValueError('invalid owned-stage stdio descriptor')
            roles.append(value['fd'])
        elif value is not None and (type(value) is not int or value not in (-1,-3) and not (key=='stderr' and value==-2)):
            raise ValueError('unsupported owned-stage stdio option')
    targets=set()
    if not isinstance(options.get('passed'),list):raise ValueError('invalid owned-stage passed descriptors')
    for pair in options['passed']:
        if (not isinstance(pair,list) or len(pair)!=2 or any(type(x) is not int for x in pair)
                or pair[0]<3 or pair[0] in targets):
            raise ValueError('invalid/duplicate owned-stage descriptor target')
        targets.add(pair[0]);roles.append(pair[1])
    if sorted(roles)!=list(range(fd_count)):
        raise ValueError('owned-stage descriptor role mismatch')
    for key in ('text','universal_newlines','restore_signals','close_fds'):
        if key in options and type(options[key]) is not bool:raise ValueError('invalid owned-stage boolean option')
    if options.get('close_fds',True) is not True:raise ValueError('owned stages require close_fds')
    for key in ('encoding','errors'):
        if key in options and options[key] is not None and not isinstance(options[key],str):
            raise ValueError('invalid owned-stage text option')
    if 'bufsize' in options and type(options['bufsize']) is not int:raise ValueError('invalid owned-stage buffering')


class State:
    def __init__(self, command, options, fds, parent, depth):
        self.handle = uuid.uuid4().hex+uuid.uuid4().hex
        self.command, self.options, self.fds = command, options, fds
        self.parent, self.depth = parent, depth
        self.proc = None
        self.done = threading.Event()
        self.closing = False
        self.cancelled = False
        self.started = False
        self.signals_sent=set()
        self.admitted = threading.Event()
        self.reaped = False
        self.release = None
        self.result = None
        self.error = None
        self.child_cpu_s = None
        self.cleanup_errors=[]
        self.cleanup_until=None
        self.term_until=None
        self.adopted_child_cpu_s=0.
        self.adopted_children=0
        self.lock = threading.RLock()


class Scope:
    def __init__(self):
        _runtime()
        self.directory = tempfile.mkdtemp(prefix='los-', dir='/tmp')
        self.path = self.directory+'/socket'
        self.lock = threading.RLock()
        self.states, self.threads = {}, []
        self.connections=threading.BoundedSemaphore(MAX_CONNECTIONS)
        self.failures=[]
        self.closing = False
        self.stopped = threading.Event()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(32)
        self.listener.settimeout(.2)
        self.server = threading.Thread(target=self._accept, name='owned-stage-broker')
        self.adoption=False
        try:
            _subreaper(True)
            self.adoption=True
            self.server.start()
        except BaseException:
            self.listener.close()
            shutil.rmtree(self.directory)
            if self.adoption:_subreaper(False)
            raise

    def prepare(self, command, options, fds, parent=None, depth=0):
        if not command or not all(isinstance(x, str) for x in command) or depth not in (0,1,2):
            raise ValueError('invalid owned-stage command/depth')
        with self.lock:
            if self.closing or parent and self.states[parent].closing:
                raise ValueError('owned-stage admission is closed')
            if len(self.states)>=MAX_STAGES:raise ValueError('owned-stage registry bound exceeded')
            state = State(command, options, fds, parent, depth)
            self.states[state.handle] = state
        return state

    def start(self, state, activate=True):
        thread = threading.Thread(target=self._spawn, args=(state,), name='owned-stage-spawn')
        with self.lock:
            if state.done.is_set() or state.started:
                raise ValueError('owned stage already settled/started')
            state.started=True
            self.threads.append(thread)
            try:thread.start()
            except BaseException:
                if thread.ident is None:
                    state.started=False
                    self.threads.remove(thread)
                raise
            if activate:self.activate(state)

    def activate(self,state):
        with self.lock:
            if self.closing or state.closing or state.parent and self.states[state.parent].closing:
                raise ValueError('owned-stage admission is closed')
            from lean_workflow import inherited_deadline,remaining
            left=remaining(inherited_deadline(state.options['env']))
            if left is not None and left<=0:raise subprocess.TimeoutExpired(state.command,0)
            state.admitted.set()

    def _signal(self, state, sig, deadline=None):
        deadline=time.monotonic()+1 if deadline is None else deadline
        if not state.lock.acquire(timeout=max(0,deadline-time.monotonic())):
            raise TimeoutError('owned signal-lock budget exhausted')
        try:
            if state.proc and not state.reaped:
                if sig in state.signals_sent:return
                # macOS denies a signal to a zombie-only group. Its held PID
                # still protects ownership, but no member needs that signal.
                if _peek_exit(state.proc.pid) and not _live_members(state.proc.pid,state.proc.pid,deadline):
                    return
                try:
                    os.killpg(state.proc.pid, sig)
                    state.signals_sent.add(sig)
                except PermissionError:
                    # Darwin may deny killpg during the exit transition before
                    # waitid publishes terminal status. Confirm that transition
                    # while retaining the PID; genuine denied live-group signals
                    # still take the direct-child fallback and remain uncertain.
                    until=min(time.monotonic()+.1,deadline)
                    while True:
                        if _peek_exit(state.proc.pid) and not _live_members(state.proc.pid,state.proc.pid,deadline):return
                        if time.monotonic()>=until:break
                        time.sleep(.005)
                    # Still stop our directly owned leader, retaining the
                    # denied group signal as uncertainty in the caller.
                    os.kill(state.proc.pid,sig)
                    raise
        finally:state.lock.release()

    def _spawn(self, state):
        readfd = error_read = error_write = None
        try:
            readfd, writefd = os.pipe()
            error_read,error_write=os.pipe()
            with state.lock:
                state.release = writefd
            options = dict(state.options)
            for key in ('stdin','stdout','stderr'):
                if isinstance(options.get(key), dict):
                    options[key] = state.fds[options[key]['fd']]
            mappings = [[target,state.fds[index]] for target,index in options.pop('passed')]
            env = dict(options['env'])
            options['env'] = env
            env.update({SOCKET_ENV:self.path,HANDLE_ENV:state.handle,DEPTH_ENV:str(state.depth+1)})
            for key in ('text','universal_newlines','encoding','errors','close_fds'):
                options.pop(key, None)
            bootstrap = [sys.executable,str(Path(__file__).with_name('lean_owned_exec.py')),
                         str(readfd),str(error_write),json.dumps(mappings)]+state.command
            proc = subprocess.Popen(bootstrap, start_new_session=True, pass_fds=tuple(
                                    [readfd,error_write]+[source for _,source in mappings]), **options)
            os.close(error_write);error_write=None
            with state.lock:
                state.proc = proc
                if os.getpgid(proc.pid) != proc.pid:
                    raise ValueError('owned stage did not create its own process group')
            while not state.admitted.wait(.01) and not state.closing:
                pass
            with state.lock:
                if not state.closing:
                    from lean_workflow import inherited_deadline,remaining
                    left=remaining(inherited_deadline(state.options['env']))
                    if left is not None and left<=0:raise subprocess.TimeoutExpired(state.command,0)
                    os.write(writefd, b'G')
                os.close(writefd)
                state.release = None
            os.close(readfd)
            readfd = None
            for fd in state.fds:
                os.close(fd)
            state.fds = []
            failure=os.read(error_read,4096)
            os.close(error_read);error_read=None
            if failure:
                detail=json.loads(failure)
                if detail['type']=='FileNotFoundError':raise FileNotFoundError(detail['message'])
                raise OSError(detail['message'])
            self._collect(state)
        except BaseException as error:
            state.closing=True
            state.error = dict(type=type(error).__name__,message=str(error))
            try:
                until=state.cleanup_until or time.monotonic()+2
                descendants=self.cancel(state.handle,include_self=False,immediate=True,deadline=until)
                state.cleanup_errors.extend(descendants['errors'])
            except BaseException as cleanup_error:
                state.cleanup_errors.append(dict(operation='subtree',error=str(cleanup_error)))
            if state.proc and not state.reaped:
                try:
                    self._signal(state,signal.SIGKILL,until)
                except BaseException as cleanup_error:
                    state.cleanup_errors.append(dict(operation='owned-group-signal',error=str(cleanup_error)))
                try:
                    drain_until=min(until+2,time.monotonic()+2)
                    while not _peek_exit(state.proc.pid) and time.monotonic()<drain_until:
                        time.sleep(.01)
                    if not _peek_exit(state.proc.pid):
                        raise RuntimeError('owned leader remains alive after KILL')
                    _reap_adopted(state,drain_until)
                    self._reap(state)
                    if _live_members(state.proc.pid,state.proc.pid,drain_until):
                        raise RuntimeError('owned group still has live members after KILL')
                except BaseException as cleanup_error:
                    state.cleanup_errors.append(dict(operation='owned-group',error=str(cleanup_error)))
            state.done.set()
        finally:
            if readfd is not None:
                os.close(readfd)
            for fd in (error_read,error_write):
                if fd is not None:os.close(fd)
            with state.lock:
                if state.release is not None:
                    os.close(state.release)
                    state.release = None
            for fd in state.fds:
                os.close(fd)
            state.fds = []
            if state.proc:
                for stream in (state.proc.stdin,state.proc.stdout,state.proc.stderr):
                    if stream:stream.close()

    def _reap(self, state):
        with state.lock:
            if state.reaped:
                return state.result
            # Tombstone before the only reap. No later signal can use this PID.
            if not _peek_exit(state.proc.pid):
                raise RuntimeError('cannot reap a live owned leader')
            state.reaped = True
            _, status, usage = os.wait4(state.proc.pid, 0)
            state.proc.returncode = os.waitstatus_to_exitcode(status)
            state.child_cpu_s=usage.ru_utime+usage.ru_stime
            return state.proc.returncode, usage

    def _collect(self, state):
        proc = state.proc
        if proc.stdin:
            proc.stdin.close()
        selector = selectors.DefaultSelector()
        output = {'stdout':bytearray() if proc.stdout else None,'stderr':bytearray() if proc.stderr else None}
        try:
            for name in ('stdout','stderr'):
                stream = getattr(proc,name)
                if stream:
                    os.set_blocking(stream.fileno(),False)
                    selector.register(stream,selectors.EVENT_READ,name)
            while not _peek_exit(proc.pid):
                self._read(selector,output,.05)
            with state.lock:
                state.closing = True
                if state.cleanup_until is None:
                    state.cleanup_until=time.monotonic()+7
                    state.term_until=state.cleanup_until-2
                until=state.cleanup_until
            errors = []
            if not state.cancelled:
                errors.extend(self.cancel(state.handle, include_self=False,deadline=until)['errors'])
            if _live_members(proc.pid,proc.pid,until):
                if not state.cancelled:self._signal(state,signal.SIGTERM,until)
                while time.monotonic()<state.term_until and _live_members(proc.pid,proc.pid,until):
                    self._read(selector,output,.05)
                if _live_members(proc.pid,proc.pid,until):
                    self._signal(state,signal.SIGKILL,until)
                    while time.monotonic()<until and _live_members(proc.pid,proc.pid,until):
                        self._read(selector,output,.05)
                if time.monotonic()>=until or _live_members(proc.pid,proc.pid,until):
                    errors.append({'operation':'verify','error':'owned group still has live members'})
            _reap_adopted(state,until)
            code, usage = self._reap(state)
            while selector.get_map() and time.monotonic()<until:
                self._read(selector,output,.05)
            if selector.get_map():
                errors.append({'operation':'pipes','error':'owned captured streams remain open'})
            until=min(until,time.monotonic()+.5)
            while True:
                try:
                    os.killpg(proc.pid,0)  # Verification only; never signal after reap.
                except ProcessLookupError:
                    break
                except OSError as error:
                    errors.append({'operation':'verify','error':str(error)})
                    break
                if time.monotonic()>=until:
                    errors.append({'operation':'verify','error':'group disappearance unconfirmed'})
                    break
                time.sleep(.01)
            state.result = dict(returncode=code,stdout=base64.b64encode(output['stdout']).decode() if output['stdout'] is not None else None,
                stderr=base64.b64encode(output['stderr']).decode() if output['stderr'] is not None else None,
                child_cpu_s=usage.ru_utime+usage.ru_stime,
                adopted_child_cpu_s=state.adopted_child_cpu_s,adopted_children=state.adopted_children,
                cpu_scope='owned leader wait4; includes children it reaped; nested intervals non-additive',
                cleanup=dict(complete=not errors,errors=errors,child_reaped=True,
                             family_cleanup='registered owned-stage groups',owned_group_gone=not errors))
        finally:
            selector.close()
            for stream in (proc.stdin,proc.stdout,proc.stderr):
                if stream:
                    stream.close()
        state.done.set()

    @staticmethod
    def _read(selector, output, timeout):
        for key,_ in selector.select(timeout):
            try:data=os.read(key.fd,65536)
            except BlockingIOError:continue
            if data:
                output[key.data].extend(data)
                if len(output[key.data])>MAX_FRAME//2:
                    raise ValueError('owned-stage captured output bound exceeded')
            else:
                selector.unregister(key.fileobj)

    def cancel(self, handle, include_self=True, immediate=False,deadline=None):
        deadline=deadline if deadline is not None else time.monotonic()+(2 if immediate else 7)
        with self.lock:
            selected=[]
            for state in self.states.values():
                ancestor=state
                while ancestor:
                    if ancestor.handle==handle:
                        if include_self or state.handle!=handle:
                            selected.append(state)
                        break
                    ancestor=self.states.get(ancestor.parent)
            for state in selected:
                state.closing=True
                state.cancelled=True
                if not state.done.is_set():
                    state.cleanup_until=min(state.cleanup_until,deadline) if state.cleanup_until is not None else deadline
                    state.term_until=state.cleanup_until if immediate else state.cleanup_until-2
                if not state.started and not state.done.is_set():
                    for fd in state.fds:os.close(fd)
                    state.fds=[]
                    state.result=dict(returncode=125,stdout=None,stderr=None,child_cpu_s=None,
                        cpu_scope='unavailable; cancelled before leader spawn',cleanup=dict(
                        complete=True,errors=[],child_reaped=True,leader_spawned=False))
                    state.done.set()
        errors=[]
        phases=((signal.SIGKILL,deadline),) if immediate else ((signal.SIGTERM,deadline-2),(signal.SIGKILL,deadline))
        for sig,until in phases:
            for state in selected:
                try:
                    self._signal(state,sig,until)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    errors.append({'operation':'killpg','signal':sig,'error':str(error)})
            while time.monotonic()<until and any(not s.done.is_set() for s in selected):
                time.sleep(.01)
            if all(s.done.is_set() for s in selected):
                break
        for state in selected:
            if not state.done.is_set():
                errors.append({'operation':'pending','error':'owned stage has not settled'})
            elif state.error:
                errors.extend(state.cleanup_errors)
            elif state.result:
                errors.extend(state.result['cleanup']['errors'])
        return dict(complete=not errors,errors=errors,child_reaped=all(s.reaped or not s.started for s in selected),
                    family_cleanup='registered owned-stage groups')

    def _accept(self):
        while not self.stopped.is_set():
            try:
                conn,_=self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if not self.connections.acquire(blocking=False):
                conn.close()
                continue
            thread=threading.Thread(target=self._request,args=(conn,),name='owned-stage-request')
            with self.lock:
                self.threads=[t for t in self.threads if t.is_alive()]
                self.threads.append(thread)
            try:thread.start()
            except BaseException as error:
                conn.close();self.connections.release()
                self.failures.append(dict(operation='request-thread',error=str(error)))

    def _request(self, conn):
        fds=[]
        try:
            conn.settimeout(2)
            pid,uid=_peer(conn)
            request,fds=_receive(conn)
            with self.lock:
                parent=self.states.get(request.get('cap'))
                if uid!=os.getuid() or not parent or not parent.proc or parent.reaped or os.getpgid(pid)!=parent.proc.pid:
                    raise ValueError('invalid/stale owned-stage lineage')
            op=request.get('op')
            if op=='spawn':
                options=request['options']
                _validate_options(options,len(fds))
                # Every received FD must have an explicit stdio/pass-fd role.
                used=[]
                for key in ('stdin','stdout','stderr'):
                    if isinstance(options.get(key),dict):used.append(options[key]['fd'])
                used += [index for _,index in options.get('passed',[])]
                if sorted(used)!=list(range(len(fds))):
                    raise ValueError('owned-stage descriptor role mismatch')
                child=self.prepare(request['command'],options,fds,parent.handle,parent.depth+1)
                fds=[]
                self.start(child,activate=False)
                _send(conn,{'handle':child.handle})
            else:
                target=self.states.get(request.get('handle'))
                if fds or not target or target.parent!=parent.handle:
                    raise ValueError('foreign owned-stage handle')
                if op=='wait':
                    timeout=request.get('timeout')
                    if timeout is not None and (not isinstance(timeout,(int,float)) or timeout<0 or timeout>86400):
                        raise ValueError('invalid owned-stage wait')
                    target.done.wait(timeout)
                    conn.settimeout(.5)
                    _send(conn,{'result':target.result,'error':target.error,'pending':not target.done.is_set(),
                                'child_cpu_s':target.child_cpu_s})
                elif op=='cancel':
                    conn.settimeout(.5)
                    _send(conn,{'cleanup':self.cancel(target.handle)})
                elif op=='activate':
                    self.activate(target)
                    _send(conn,{'activated':True})
                else:
                    raise ValueError('unknown owned-stage request')
        except BaseException as error:
            try:_send(conn,{'error':{'type':type(error).__name__,'message':str(error)}})
            except OSError:pass
        finally:
            for fd in fds:os.close(fd)
            conn.close()
            self.connections.release()

    def close(self):
        with self.lock:
            self.closing=True
            roots=[s for s in self.states.values() if s.parent is None and not s.done.is_set() and not s.cancelled]
        for state in roots:self.cancel(state.handle)
        self.stopped.set()
        try:self.listener.shutdown(socket.SHUT_RDWR)
        except OSError:pass
        self.listener.close()
        self.server.join(timeout=2)
        until=time.monotonic()+2
        for thread in self.threads:
            if thread.ident is not None:thread.join(timeout=max(0,until-time.monotonic()))
        settled=(not self.server.is_alive() and not any(t.is_alive() for t in self.threads)
                 and all(s.done.is_set() and (s.proc is None or s.reaped) for s in self.states.values()))
        if settled and self.adoption:
            if sys.platform=='linux':
                settled=all(not _live_members(s.proc.pid,-1,include_zombies=True) for s in self.states.values() if s.proc)
            if settled:
                _subreaper(False)
                self.adoption=False
        complete=settled and not self.failures
        if complete:
            shutil.rmtree(self.directory)
        return complete


class Process:
    def __init__(self, state, scope=None, options=None, path=None, cap=None):
        self.state,self.scope=state,scope
        self.options=options if options is not None else state.options
        self.path,self.cap=path,cap
        self.returncode=None
        self.child_cpu_s=None
        self.cpu_scope='unavailable before owned-child reap'
        self.last_cleanup=None
        self.adopted_child_cpu_s=None

    def start(self):
        if self.scope:self.scope.start(self.state,activate=False)

    def activate(self):
        if self.scope:self.scope.activate(self.state)
        else:_rpc(self.path,dict(op='activate',cap=self.cap,handle=self.state))

    def communicate(self, timeout=None):
        if self.scope:
            if not self.state.done.wait(timeout):
                raise subprocess.TimeoutExpired(self.state.command,timeout)
            response={'result':self.state.result,'error':self.state.error,'child_cpu_s':self.state.child_cpu_s}
        else:
            try:
                response=_rpc(self.path,dict(op='wait',cap=self.cap,handle=self.state,timeout=timeout),timeout=None if timeout is None else timeout+1)
            except socket.timeout:
                raise subprocess.TimeoutExpired('owned stage',timeout) from None
            if response.get('pending'):
                raise subprocess.TimeoutExpired('owned stage',timeout)
        if response.get('error'):
            self.child_cpu_s=response.get('child_cpu_s')
            if self.child_cpu_s is not None:self.cpu_scope='owned leader wait4; includes children it reaped; nested intervals non-additive'
            error=response['error']
            if error['type']=='FileNotFoundError':raise FileNotFoundError(error['message'])
            if error['type']=='TimeoutExpired':raise subprocess.TimeoutExpired('owned admission',0)
            raise RuntimeError('owned stage failed: '+error['message'])
        result=response['result']
        self.returncode=result['returncode']
        self.child_cpu_s=result['child_cpu_s']
        self.cpu_scope=result['cpu_scope']
        self.last_cleanup=result['cleanup']
        self.adopted_child_cpu_s=result.get('adopted_child_cpu_s')
        return _decoded(result['stdout'],self.options),_decoded(result['stderr'],self.options)

    def cleanup(self):
        return self.scope.cancel(self.state.handle) if self.scope else _rpc(self.path,
            dict(op='cancel',cap=self.cap,handle=self.state),timeout=10)['cleanup']

    def close(self):
        return self.scope.close() if self.scope else True


def _rpc(path, request, fds=(), timeout=2):
    directory=os.lstat(str(Path(path).parent))
    endpoint=os.lstat(path)
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid!=os.getuid()
            or stat.S_IMODE(directory.st_mode)!=0o700 or not stat.S_ISSOCK(endpoint.st_mode)
            or endpoint.st_uid!=os.getuid()):
        raise ValueError('invalid private broker endpoint')
    conn=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    try:
        conn.settimeout(timeout)
        conn.connect(path)
        _send(conn,request,fds)
        response,received=_receive(conn)
        if received:
            for fd in received:os.close(fd)
            raise ValueError('unexpected broker response descriptors')
        if response.get('error') and not request['op']=='wait':
            if response['error']['type']=='TimeoutExpired':raise subprocess.TimeoutExpired('owned admission',0)
            raise ValueError('owned-stage broker rejected request: '+response['error']['message'])
        return response
    finally:
        conn.close()


def prepare(command, kwargs):
    command=list(map(os.fspath,command))
    options,fds=_options(kwargs)
    try:
        path,cap=os.environ.get(SOCKET_ENV),os.environ.get(HANDLE_ENV)
        for key in (SOCKET_ENV,HANDLE_ENV,DEPTH_ENV):
            if key in options['env'] and options['env'][key]!=os.environ.get(key,'0' if key==DEPTH_ENV else None):
                raise ValueError('child cannot reset owned-stage lineage metadata')
        if path or cap:
            if not path or not cap or len(cap)!=64:
                raise ValueError('invalid owned-stage broker metadata')
            response=_rpc(path,dict(op='spawn',cap=cap,command=command,options=options),fds)
            return Process(response['handle'],options=options,path=path,cap=cap)
        if os.environ.get(DEPTH_ENV,'0')!='0':
            raise ValueError('nonroot stage depth requires authenticated broker scope')
        scope=Scope()
        try:
            state=scope.prepare(command,options,fds)
        except BaseException:
            scope.close()
            raise
        fds=[]
        return Process(state,scope)
    finally:
        for fd in fds:os.close(fd)
