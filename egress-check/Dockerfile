# Egress check image: builds the server and web UI (with internet, at image
# build time), then runs them on a network with no route out. See README.md.
FROM node:26-bookworm

ARG VITE_PLUS_INSTALLER=https://vite.plus

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git iproute2 libsecret-1-dev pkg-config python3 tcpdump \
  && rm -rf /var/lib/apt/lists/*

ENV VP_BIN_DIR=/opt/vite-plus/bin \
    VP_DATA_DIR=/opt/vite-plus \
    VP_CACHE_DIR=/opt/vite-plus/cache \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN curl -fsSL "$VITE_PLUS_INSTALLER" -o /tmp/vp-install.sh \
  && VP_NODE_MANAGER=no bash /tmp/vp-install.sh \
  && rm /tmp/vp-install.sh \
  && ln -sf "$VP_BIN_DIR/vp" /usr/local/bin/vp

WORKDIR /app
COPY . .

RUN vp install --filter=t3... --filter=@t3tools/web... --filter=@t3tools/scripts... \
  && vp run --filter t3 build \
  && node apps/web/node_modules/playwright/cli.js install --with-deps --only-shell chromium

RUN useradd --create-home --shell /bin/bash t3 \
  && chmod -R a+rX /app /opt

ENTRYPOINT ["bash", "/app/egress-check/run.sh"]
