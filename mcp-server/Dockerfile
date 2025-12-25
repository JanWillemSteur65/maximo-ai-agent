FROM registry.access.redhat.com/ubi9/nodejs-20

WORKDIR /opt/app-root/src

USER 0
RUN mkdir -p /opt/app-root/src && chown -R 1001:0 /opt/app-root/src

COPY --chown=1001:0 package*.json ./
USER 1001
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy UI sources (and optionally pre-built ui/dist)
USER 0
COPY --chown=1001:0 ui ./ui
RUN chown -R 1001:0 /opt/app-root/src/ui
USER 1001

RUN if [ -d ui/dist ]; then echo "MCP UI already built (ui/dist present)";     else npm --prefix ui install && npm --prefix ui run build; fi

USER 0
RUN rm -rf /opt/app-root/src/public && cp -r /opt/app-root/src/ui/dist /opt/app-root/src/public && chown -R 1001:0 /opt/app-root/src/public
USER 1001

COPY --chown=1001:0 server.mjs ./server.mjs

ENV PORT=8081
EXPOSE 8081

CMD ["npm","start"]
