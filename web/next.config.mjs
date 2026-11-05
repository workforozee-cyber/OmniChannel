/** @type {import('next').NextConfig} */
// Single-service mode: the browser calls same-origin /api/*, and Next forwards it to the API process
// running inside the same container. (INTERNAL_API_URL is baked in at build time.)
const internalApi = process.env.INTERNAL_API_URL;
const nextConfig = {
  async rewrites() {
    return internalApi ? [{ source: '/api/:path*', destination: `${internalApi}/api/:path*` }] : [];
  },
};
export default nextConfig;
