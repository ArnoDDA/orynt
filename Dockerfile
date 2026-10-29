FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /data /app/.local && chown -R node:node /data /app/.local
ENV NODE_ENV=production PORT=3000 ORYNT_DATA_DIR=/data ORYNT_DEMO_ONLY=1
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "scripts/serve-online.mjs"]
