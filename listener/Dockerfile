# backmesh's listener image: the compiled service on
# Node 22 slim, with production dependencies only. Built from the repository
# root, so it compiles the same src/ that CI verifies.
ARG NODE_IMAGE=mirror.gcr.io/library/node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN yarn build \
    && yarn install --frozen-lockfile --ignore-scripts --production

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist

LABEL org.opencontainers.image.source="https://github.com/backmesh/backmesh" \
      org.opencontainers.image.title="backmesh listener" \
      org.opencontainers.image.description="The scale-set listener that runs each GitHub Actions job in its own anycloud VM Job"

USER node
ENTRYPOINT ["node", "dist/listener/index.js"]
