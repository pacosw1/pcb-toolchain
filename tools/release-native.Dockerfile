# Extends the existing immutable native CI image; never changes its tag/content.
ARG NATIVE_BASE=iot-lab-release-base:d7909a97456e
FROM ${NATIVE_BASE}
USER root
ARG RELEASE_RECIPE_SHA256
LABEL org.iot-lab.release-recipe=${RELEASE_RECIPE_SHA256}
COPY requirements-gerbercheck.txt /opt/gerbercheck/requirements.txt
COPY wheels/ /opt/gerber-wheels/
# Execute a hash-verified pip wheel directly; no apt, system pip or externally
# managed Python override. Installation has no network access at build time.
RUN PYTHONPATH=/opt/gerber-wheels/pip-25.0.1-py3-none-any.whl python3 -m pip install \
      --no-index --find-links=/opt/gerber-wheels --only-binary=:all: --require-hashes \
      --target=/opt/gerbercheck/lib -r /opt/gerbercheck/requirements.txt \
    && printf '#!/bin/sh\nexport PYTHONPATH=/opt/gerbercheck/lib${PYTHONPATH:+:$PYTHONPATH}\nexec /usr/bin/python3 "$@"\n' > /opt/gerbercheck/python \
    && chmod 755 /opt/gerbercheck/python \
    && /opt/gerbercheck/python -c 'import platform,sys; from importlib.metadata import version; assert platform.machine()=="x86_64"; assert sys.version_info[:2]==(3,13); assert {p:version(p) for p in ("gerbonara","shapely","click","numpy")}=={"gerbonara":"0.13.0","shapely":"2.0.7","click":"8.1.8","numpy":"2.1.3"}; import gerbonara,shapely,numpy' \
    && rm -rf /opt/gerber-wheels
ENV GERBERCHECK_PY=/opt/gerbercheck/python
USER 1000:1000
