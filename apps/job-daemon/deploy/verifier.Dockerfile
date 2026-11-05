# Offline, digest-pinned inputs only. Build context must contain the committed tools tree.
ARG NODE_IMAGE
ARG KICAD_IMAGE
FROM ${NODE_IMAGE} AS node
FROM ${KICAD_IMAGE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --chown=0:0 tools /opt/pcb-verifier/tools
USER 65534:65534
