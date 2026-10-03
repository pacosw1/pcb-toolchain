# Image iot-lab-route:10.0-fr241 for tools/remote.sh (REMOTE_IMAGE=iot-lab-route:10.0-fr241).
# Freerouting 2.4.1 needs Java 25. Freerouting 2.1.0 (image iot-lab-route:10.0) lost most of its result
# at the job timeout and ignored -mp without a GUI (fixed in 2.2.0); see the 2026-10-03 routing report.
# Build on the box:
#   cd /srv/iot-lab-route/image-fr241 (this file as Dockerfile + freerouting-2.4.1.jar,
#   sha256 251101c3eeac22d7e7dfcf6796603279e5d1000283eb82d8f093780f7afc6aa9) && docker build -t iot-lab-route:10.0-fr241 .
FROM eclipse-temurin:25-jre AS java
FROM kicad/kicad:10.0
USER root
COPY --from=java /opt/java/openjdk /opt/java25
COPY freerouting-2.4.1.jar /opt/freerouting/freerouting-2.4.1.jar
RUN chmod -R a+rX /opt/freerouting /opt/java25 && mkdir -p /Applications/KiCad/KiCad.app/Contents/MacOS && ln -s /usr/bin/kicad-cli /Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
ENV FREEROUTING_JAR=/opt/freerouting/freerouting-2.4.1.jar FREEROUTING_JAVA=/opt/java25/bin/java
USER kicad
