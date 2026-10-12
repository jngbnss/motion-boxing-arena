# Motion Boxing Arena 서버 (REST + Colyseus duel, 포트 하나).
# 빌드 컨텍스트는 저장소 루트: docker build -f apps/server/Dockerfile -t mba-server .
# 실행:    docker run -p 2567:2567 -v mba-data:/data -e PUBLIC_BASE_URL=https://api.example.com mba-server
FROM node:22-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# 의존성 레이어: 워크스페이스 매니페스트만 먼저 복사해 캐시를 살린다 (packageManager 버전은 corepack이 고정)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/combat/package.json packages/combat/
COPY packages/motion/package.json packages/motion/
RUN pnpm install --frozen-lockfile --prod --filter "@mba/server..."

# 워크스페이스 패키지는 TS 소스를 그대로 export하고, Node ≥22.18이 타입을 스트리핑해 실행한다
COPY packages/shared/src packages/shared/src
COPY packages/combat/src packages/combat/src
COPY apps/server/src apps/server/src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=2567 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 2567

WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]
