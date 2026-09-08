# =============================================================================
# TARA
# =============================================================================
# Two images from one file, because they have genuinely different jobs.
#
#   --target web  (the default)  serves requests. Small, no shell tools, no
#                                Postgres client, no source. This is what
#                                scales out.
#   --target ops                 runs the things that are not requests:
#                                migrations, the SQL guards, the order sweep,
#                                backups, the restore drill. It carries the
#                                Postgres 16 client tools and the scripts, and
#                                it is not exposed to the internet.
#
# Building one image for both would mean putting `pg_dump` and every dev
# dependency on the machine that answers customer requests, which is a larger
# attack surface for no benefit. Building two files would mean two copies of
# the build.
#
#     docker build -t tara:web .
#     docker build -t tara:ops --target ops .
#
# On the version: Node 22 because package.json requires >=20.11 and 22 is the
# current LTS. Debian rather than Alpine because Prisma's engines want glibc
# and OpenSSL 3, and because the ops image needs the official Postgres client
# packages — musl versions of both exist and neither is worth the debugging.
# =============================================================================

# -----------------------------------------------------------------------------
# base — shared settings, nothing installed
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# -----------------------------------------------------------------------------
# deps — every dependency, including the ones only the build needs
# -----------------------------------------------------------------------------
FROM base AS deps

# Only the manifests, so this layer is cached until a dependency actually
# changes. Copying the whole tree here would rebuild node_modules on every
# edit to a component.
COPY package.json package-lock.json ./

# `npm ci` rather than `npm install`: it installs exactly the lockfile and
# fails if the two disagree, which is the difference between a reproducible
# image and one that quietly picks up a new minor version at 3am.
RUN npm ci

# -----------------------------------------------------------------------------
# build — generate the Prisma client, compile the app
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `npm run build` is `prisma generate && next build`. The generate step needs
# prisma/schema.prisma, which arrived with the COPY above.
#
# NOTE ON BUILD-TIME CONFIGURATION. Nothing in this application needs a secret
# at build time, and it must stay that way: an ARG is visible in `docker
# history` forever. The one thing to watch is `NEXT_PUBLIC_*` — those are
# inlined into the CLIENT bundle at build time. Today every use is in a server
# component (verified: a site key set only at runtime does reach the page), so
# they are all runtime configuration. If somebody later reads one from a `'use
# client'` component it will silently bake in whatever was set here, and it
# will need to become an ARG.
RUN npm run build

# -----------------------------------------------------------------------------
# web — what serves requests
# -----------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production
ENV PORT=3000
# Next's standalone server binds localhost by default, which inside a container
# means nothing outside it can connect.
ENV HOSTNAME=0.0.0.0

# `output: 'standalone'` traces the files actually reached at runtime: 86 MB
# against 737 MB of node_modules, and none of the build tooling. The three
# COPY lines below are exactly the layout that was verified to boot and serve —
# server.js, .next/static for the hashed assets, and public/ for the icons and
# the service worker.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# `node` exists in the base image with uid 1000. Running as root in a
# container is the default and it should not be: a process that only reads
# files and answers HTTP has no need to be able to write to its own image.
USER node

EXPOSE 3000

# `fetch` rather than curl, because curl is not in the slim image and adding
# it to run one request would be the only reason it was there. /api/health
# returns 503 when the database is unreachable, so an instance that cannot
# actually serve is taken out of rotation instead of answering with errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# -----------------------------------------------------------------------------
# ops — migrations, the SQL guards, the sweep, backups, the restore drill
# -----------------------------------------------------------------------------
FROM base AS ops
ENV NODE_ENV=production

# The Postgres 16 client tools. From PGDG rather than Debian's own repository,
# which ships 15 — and pg_dump 15 REFUSES to dump a 16 server, so the version
# here is not a preference. `psql` matters just as much: `npm run
# prisma:guards` shells out to it, and without it the append-only triggers on
# the credits ledger silently never get applied.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gnupg curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y --auto-remove gnupg \
  && rm -rf /var/lib/apt/lists/*

# The full dependency tree, not the traced subset: these commands run `tsx`
# over TypeScript in `scripts/`, and the Prisma CLI for migrations. Both are
# devDependencies, and both are the point of this image.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
COPY tsconfig.json next.config.ts ./

# The generated client, rather than running `prisma generate` again — it is
# already built and the binary target is the same Debian image.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

USER node

# No default command on purpose. This image is invoked with the job you want,
# and naming them here would suggest one of them is the normal case:
#
#   docker run --rm tara:ops npm run db:setup          # migrate + guards + seed
#   docker run --rm tara:ops npx prisma migrate deploy # migrations alone
#   docker run --rm tara:ops npm run prisma:guards
#   docker run --rm tara:ops npm run jobs:orders
#   docker run --rm -v /srv/backups:/backups tara:ops \
#     npm run db:backup -- --dir /backups --keep 14
#   docker run --rm -v /srv/backups:/backups tara:ops \
#     npm run db:restore-check -- --file /backups/tara-….dump
#
# `npm run db:purge-demo` and `npm run admin:grant` live here too, which is
# the honest home for them: both need database credentials and neither belongs
# on a public-facing container.
CMD ["node", "-e", "console.error('This image runs a named job. See the Dockerfile.'); process.exit(2)"]
