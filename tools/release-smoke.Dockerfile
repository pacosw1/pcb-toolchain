# Scratch image of scripts/release-smoke.sh: one container with everything a release runs, so a bundle can be tried on a real board.
# Never a production tag. KiCad 10, the pinned nightly and the Java router come from the route image; Node and kicad-happy from the
# native CI image. route-coverage, iotroute and the rest come from the bundle under test.
ARG ROUTE_BASE=iot-lab-route:10.0-nightly-4fe1ca2060
ARG NATIVE_BASE=iot-lab-ci:native-kicad10.0.6-node22-v2
FROM ${NATIVE_BASE} AS native

FROM ${ROUTE_BASE}
USER root
COPY --from=native /usr/local/bin/node /usr/local/bin/node
COPY --from=native /opt/kicad-happy /opt/kicad-happy
RUN git config --system --add safe.directory /opt/kicad-happy
# PCB_JOBS_LOCAL: the jobs of tools/lib/daemon-job.ts run in this container, which already is the job image; it runs with --network none.
ENV KICAD_CLI=/usr/bin/kicad-cli KICAD_API_CLI=/usr/local/bin/kicad-cli-nightly \
    KICAD_PYTHON=/usr/bin/python3 PYTHON_MODERN=/usr/bin/python3 KICAD_SHARED=/usr/share/kicad KICAD_HAPPY_DIR=/opt/kicad-happy \
    KICAD_CONFIG_HOME=/tmp/smoke-kicad XDG_CONFIG_HOME=/tmp/smoke-config XDG_CACHE_HOME=/tmp/smoke-cache XDG_DATA_HOME=/tmp/smoke-data \
    KICAD10_3RD_PARTY=/tmp/smoke-thirdparty PCB_JOBS_LOCAL=1
RUN mkdir -p "$KICAD_CONFIG_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$KICAD10_3RD_PARTY" \
    && chmod -R a+rwx "$KICAD_CONFIG_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$KICAD10_3RD_PARTY"
RUN test "$(node --version)" = v22.23.2 && test "$(kicad-cli --version)" = 10.0.6 \
    && python3 -c 'import pcbnew; assert pcbnew.Version() == "10.0.6"'
USER 1000:1000
