# Imagem do relay: só o Node e dois artefatos já gerados por `pnpm pack:relay`
# (relay.mjs com as dependências embutidas e o PWA em public/).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    FAKL_RELAY_STATIC=/app/public \
    FAKL_RELAY_DATA=/data
COPY relay.mjs ./relay.mjs
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/saude || exit 1
CMD ["node", "relay.mjs"]
