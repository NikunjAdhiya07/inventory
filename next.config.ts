import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: ["192.168.0.132","https://inventory-indiana1.vercel.app"],
  // The dashboard is the root route; /dashboard is a common guess. Keep it
  // temporary (307) so a real /dashboard page later isn't fighting a cached 308.
  async redirects() {
    return [{ source: "/dashboard", destination: "/", permanent: false }];
  },
};

export default nextConfig;
