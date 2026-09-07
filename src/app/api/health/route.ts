import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * Is this instance able to serve?
 *
 * For a container orchestrator, a load balancer, and the compose healthcheck.
 * It answers two different questions and says which:
 *
 *  - the process is up and routing works — that is implied by any answer at
 *    all;
 *  - the database is reachable, which is what actually decides whether this
 *    instance can do anything useful. A `SELECT 1` rather than a real query:
 *    the point is that the connection pool is alive, and a health check that
 *    does real work becomes a load generator when something starts flapping.
 *
 * A failing database gives **503**, so a rolling deploy does not send traffic
 * to an instance that cannot answer, and a load balancer takes it out rather
 * than serving five hundred errors on its behalf.
 *
 * It deliberately says nothing else. No version, no host name, no migration
 * state, no counts: this is the one route that is public by design, and every
 * detail added here is a detail handed to whoever is scanning.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, database: 'up' });
  } catch {
    // The reason is deliberately not returned — it would carry the host name
    // and often the credentials shape. It IS logged, where operators can see
    // it and strangers cannot.
    console.error('health: database unreachable');
    return NextResponse.json({ ok: false, database: 'down' }, { status: 503 });
  }
}
