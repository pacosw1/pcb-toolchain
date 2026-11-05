# Image iot-lab-route:10.0 for tools/remote.sh. Build on the box:
#   cd /srv/iot-lab-route/image (this file as Dockerfile + freerouting-2.1.0.jar + fastroute + route-coverage) && docker build -t iot-lab-route:10.0 .
# fastroute: the Linux build of github.com/parisxmas/fastroute. route-coverage: bin/route-coverage-linux-x86_64 of the bundle. Both for iotroute fastroute.
# The kicad-cli link lets tools with the Mac kicad-cli path (pcbtool.ts) run unchanged.
FROM kicad/kicad:10.0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-21-jre-headless && rm -rf /var/lib/apt/lists/*
COPY freerouting-2.1.0.jar /home/kicad/Documents/KiCad/9.0/3rdparty/plugins/app_freerouting_kicad-plugin/jar/freerouting-2.1.0.jar
RUN chown -R kicad:kicad /home/kicad/Documents && mkdir -p /Applications/KiCad/KiCad.app/Contents/MacOS && ln -s /usr/bin/kicad-cli /Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
COPY fastroute route-coverage /usr/local/bin/
ENV FASTROUTE_BIN=/usr/local/bin/fastroute ROUTE_COVERAGE_BIN=/usr/local/bin/route-coverage
USER kicad
