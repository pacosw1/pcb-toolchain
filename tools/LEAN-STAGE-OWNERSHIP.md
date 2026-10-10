# Owned routing stages (CIP 777)

`lean_workflow.run_stage` owns cooperating subprocess stages through a broker
inside the root Python process. Nested controllers request stages from that
broker; stopping a controller cannot hide its separately grouped helpers from
root cancellation. This replaces the previous independent supervisor groups,
which could leave a TERM-ignoring helper alive after the outer controller died.

The broker records each pending spawn before starting it. A bootstrap cannot
execute the requested command until its authenticated controller releases it.
Cancellation closes admission and release pipes, then signals every registered
owned group. Kernel peer identity, the caller's registered group and an opaque
stage capability authorize requests; callers cannot submit a PID to kill.
Leader PIDs remain unreaped until the final possible signal. After reaping,
group probes only verify disappearance; they never signal a potentially reused
PID. A successful leader must also leave no unaccounted helpers or captured
streams before its stage reports complete.

The root TERM grace remains five seconds, followed by two seconds for KILL and
reaping. Nested stages share the existing absolute cleanup deadline. Broker
thread and descriptor draining has a separate two-second bound; this is not a
claim that every failure returns within seven seconds. Unsupported runtime
capabilities, malformed process observations, denied live-group signals and
unsettled ownership remain explicit cleanup failures. Registry admission is
limited to 256 stages, 32 simultaneous connection handlers and 16 passed file
descriptors; supported stage depths are 0, 1 and 2.

Linux uses `/proc` rather than requiring `ps`. A process-local child subreaper
allows the root broker to reap orphaned same-group children in containers
without an init process. The prior subreaper setting is preserved and restored
after settled ownership. Reaping uses exact PIDs only for zombie nonleaders
adopted by this process in a still-held owned group; it never uses `waitpid(-1)`.
Darwin uses native `ps` observations. An unknown `?` run state is conservatively
live, including the observed transient `?E` exit state. Arbitrary external
programs that create unregistered separate sessions are outside this ownership
contract.

Stage events report wall time and actual leader `wait4` CPU, including children
that leader reaped. Adopted-child CPU is separate. Nested intervals are not
additive; unavailable CPU is labelled unavailable. KiCad in-process import and
mandatory fill spans report the calling process and its reaped children
separately. Their deadline checks occur before and after blocking native calls;
the enclosing stage watchdog supplies preemption. Required fill, native DRC,
schematic parity and electrical rules are unchanged.

The focused regression command is:

```sh
PYTHONPATH=tools python3 -W error::ResourceWarning -m unittest \
  test_lean_owned test_fastroute_phases test_lean_clock \
  test_lean_workflow test_lean_resources
```

It exercises paused and responsive nested controllers, pending admission,
expired deadlines, FD remapping, exact caller cwd/environment, original error
preservation and same-group orphan cleanup. Native board gates are separate;
these process fixtures do not establish board qualification or routing quality.
