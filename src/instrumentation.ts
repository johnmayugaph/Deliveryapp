import type { Instrumentation } from 'next';

/**
 * Where server errors are caught.
 *
 * `onRequestError` is Next.js's own hook and it is the reason this feature is
 * eight files rather than a try/catch in eighty places: it fires for an
 * uncaught error in a server component, a route handler or a server action,
 * whatever threw and wherever. Nothing has to remember to call the reporter.
 *
 * It runs in the Node runtime only, hence the import inside the function —
 * this file is also loaded in the edge runtime, where Prisma does not exist,
 * and a top-level import would break the build rather than the reporting.
 *
 * The hook must not throw. `reportError` already guarantees that; the wrapper
 * here is belt and braces, because an error thrown out of the error handler is
 * the one failure this whole file cannot report.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { reportError } = await import('@/lib/monitoring/report');
    const { ErrorSource } = await import('@prisma/client');

    // Next tells us which kind of thing was running. A server action and a
    // page render fail in different ways and are triaged differently, so the
    // distinction is worth keeping rather than flattening to "server".
    const source =
      context.routerKind === 'App Router' && context.routeType === 'action'
        ? ErrorSource.SERVER_ACTION
        : ErrorSource.SERVER_REQUEST;

    await reportError(error, {
      source,
      // `routePath` is the route SHAPE — /orders/[orderId] — which is exactly
      // what to group on. `request.path` would split one fault per order.
      route: context.routePath || request.path,
      digest: (error as { digest?: string }).digest,
    });
  } catch (hookFailure) {
    console.error('onRequestError: failed to report', hookFailure);
  }
};
