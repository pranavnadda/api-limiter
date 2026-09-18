/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // WHY: Run middleware in the Node.js runtime (not Edge) so it shares the
    // same module singletons (MemoryStore + metrics collector) as the Node
    // route handlers. Without this, middleware runs in a separate Edge isolate
    // and /api/metrics would always read a different (empty) metrics instance.
    nodeMiddleware: true,
  },
};

module.exports = nextConfig;