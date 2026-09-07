import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Emit a self-contained server bundle at `.next/standalone`.
   *
   * This is what the container runs. Without it a production image has to
   * carry the whole `node_modules` tree — roughly half a gigabyte of it — most
   * of which is build tooling that has no business on a server that only
   * answers requests. With it, Next traces the files actually reached at
   * runtime and copies them, and `next start` keeps working unchanged for
   * anybody deploying without a container.
   */
  output: 'standalone',

  experimental: {
    typedRoutes: false,
  },
};

export default nextConfig;
