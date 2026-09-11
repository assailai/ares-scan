# The portable form of the scanner: any CI system, or a laptop.
#
#   docker run --rm -e ARES_API_KEY ghcr.io/assailai/ares-scan:1 \
#     --ares-url https://app.assailai.com --profile <id> --fail-on 'critical>0,high>0'
#
# Two stages so the shipped image carries no TypeScript and no dev dependencies. The package has
# ZERO runtime dependencies, so the final layer is the base image plus a few kilobytes of
# JavaScript, and there is no third-party code in a customer's build to reason about.

FROM node:22-alpine AS build
WORKDIR /build
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npm run bundle

FROM node:22-alpine
WORKDIR /app
COPY --from=build /build/dist ./dist
# BOTH an entrypoint and a command on PATH, and the second one is not decoration: GitLab CI runs
# its `script:` lines in a shell inside the container and ignores ENTRYPOINT entirely, so an
# image that only had one would work under `docker run` and fail on every GitLab pipeline.
RUN printf '#!/bin/sh\nexec node /app/dist/index.cjs "$@"\n' > /usr/local/bin/ares-scan \
    && chmod +x /usr/local/bin/ares-scan
# Runs as a non-root user: this container reaches the network with a customer's API key, and
# nothing it does needs root.
USER node
ENV NODE_ENV=production
ENTRYPOINT ["ares-scan"]
