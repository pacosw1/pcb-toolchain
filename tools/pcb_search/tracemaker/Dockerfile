# Isolated upstream build for CIP 839 experiments. No project boards enter this
# build; native KiCad acceptance runs in a separate pinned runtime.
FROM ubuntu:26.04
ARG TM_COMMIT=db5950f4b8710d322ecaea3599077688a158ebfb
ARG BUILD_JOBS=8
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates git cmake ninja-build g++-15 libeigen3-dev libcli11-dev \
    nlohmann-json3-dev libzstd-dev libboost-dev libsqlite3-dev time \
    && rm -rf /var/lib/apt/lists/*
RUN git init /src && git -C /src remote add origin https://github.com/DingoOz/TraceMaker.git \
    && git -C /src sparse-checkout init --cone \
    && git -C /src sparse-checkout set src cmake bindings \
    && git -C /src fetch --depth 1 --filter=blob:none origin "${TM_COMMIT}" \
    && git -C /src -c advice.detachedHead=false checkout --detach FETCH_HEAD \
    && test "$(git -C /src rev-parse HEAD)" = "${TM_COMMIT}"
# Match upstream's cpu-only/dist presets (including TM_WERROR=ON).
RUN cmake -S /src -B /build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo \
    -DTM_ENABLE_CUDA=OFF -DTM_ENABLE_METAL=OFF -DTM_BUILD_TESTS=OFF -DTM_BUILD_PYTHON=OFF \
    && cmake --build /build --target tracemaker tracemaker-place --parallel "${BUILD_JOBS}"
LABEL org.opencontainers.image.source="https://github.com/DingoOz/TraceMaker" \
      org.opencontainers.image.revision="${TM_COMMIT}" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
ENV PATH="/build/src/app:/build/src/place:${PATH}"
WORKDIR /work
