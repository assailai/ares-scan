# The portable form of the scanner: any CI system, or a laptop.
#
#   docker run --rm -e ARES_API_KEY ghcr.io/assailai/ares-scan:1 \
#     --ares-url https://ares.assailai.com --profile <id> --fail-on 'critical>0,high>0'
#
# Two stages so the shipped image carries no TypeScript and no dev dependencies. The package has
# ZERO runtime dependencies, so the final layer is the base image plus a few kilobytes of
# JavaScript, and there is no third-party code in a customer's build to reason about.
#
# the Node patch release is PINNED, where it used to float on `node:22-alpine`. The floating tag
# only took a fix when somebody happened to republish: 1.1.0 was built on 22.23.3 and kept it after
# CVE-2026-111497 (Brotli, CISA KEV on 2026-10-27) was fixed in 22.23.4, and nothing said so until
# an external security assessment did (ARES-1993). A pin makes the runtime a reviewed line that
# moves on purpose, and the publish workflow's vulnerability gate refuses one with a fix available.

FROM node:22.23.4-alpine AS build
WORKDIR /build
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npm run bundle

FROM node:22.23.4-alpine
WORKDIR /app
# the runtime needs `node` and nothing else, so the package managers the base image bundles (npm,
# npx, yarn, corepack) go. They are never run here, but every scanner a customer points at this
# image reports their dependencies, and npm's are where the base image's fixable findings sit.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
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
