# Containment foundation only. Subscription CLIs are deliberately not installed.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
USER root
RUN mkdir -p /work /input /opt/control && chown node:node /work
WORKDIR /work
USER node
