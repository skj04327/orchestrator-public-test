# Diagnostic image only. Context must contain ONLY public package files and the
# checksum-verified official agy release. Never copy a home/auth/game directory.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
COPY node_modules /opt/cli/node_modules
COPY agy /usr/local/bin/agy
# Linux amd64 diagnostic context: npm --ignore-scripts leaves a placeholder.
# Select the downloaded official optional binary without running postinstall.
RUN rm /opt/cli/node_modules/.bin/claude && ln -s ../@anthropic-ai/claude-code-linux-x64/claude /opt/cli/node_modules/.bin/claude && chmod 0555 /opt/cli/node_modules/@anthropic-ai/claude-code-linux-x64/claude
ENV PATH="/opt/cli/node_modules/.bin:${PATH}"
USER node
WORKDIR /tmp
