# Image iot-lab-route:10.0-nightly-4fe1ca2060: iot-lab-route:10.0 plus the pinned KiCad nightly for `iotroute board-json`, in one
# image. KiCad 10 keeps refill, DRC, parity and acceptance; the nightly only serves the API and never saves a board.
# The PPA keeps no old builds, so the pin is the image on the box, iot-lab-kicad-nightly:4fe1ca2060 (Ubuntu 24.04 with
# ppa:kicad/kicad-dev-nightly, kicad-nightly 202610272031+4fe1ca2060). Build on the box:
#   docker build -f remote-route-nightly.Dockerfile -t iot-lab-route:10.0-nightly-4fe1ca2060 .
# The route image is Debian 13 and the nightly Ubuntu 24.04, so the nightly brings its own libraries and loader under /opt and
# kicad-cli is patched to use that loader; the KiCad 10 tools see nothing of them.
FROM iot-lab-kicad-nightly:4fe1ca2060 AS nightly

FROM iot-lab-route:10.0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends patchelf && rm -rf /var/lib/apt/lists/*
COPY --from=nightly /usr/lib /opt/kicad-nightly/usr/lib
COPY --from=nightly /usr/share/kicad-nightly /usr/share/kicad-nightly
RUN ln -s /opt/kicad-nightly/usr/lib/kicad-nightly /usr/lib/kicad-nightly \
    && patchelf --set-interpreter /opt/kicad-nightly/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /opt/kicad-nightly/usr/lib/kicad-nightly/bin/kicad-cli \
    && printf '%s\n' '#!/bin/sh' \
       'R=/opt/kicad-nightly/usr/lib' \
       'LD_LIBRARY_PATH=$R/kicad-nightly/lib/x86_64-linux-gnu:$R/kicad-nightly/lib:$R/x86_64-linux-gnu KICAD_PATH=/usr/share/kicad-nightly exec $R/kicad-nightly/bin/kicad-cli "$@"' \
       > /usr/local/bin/kicad-cli-nightly \
    && chmod +x /usr/local/bin/kicad-cli-nightly
USER kicad
