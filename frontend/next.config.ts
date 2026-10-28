import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  async headers() {
    return [
      {
        // Заголовки нужны всему документу, а не только /room/*: при клиентском
        // переходе (next/link) документ не перезагружается, поэтому без COOP/COEP
        // на главной странице crossOriginIsolated остаётся false и SharedArrayBuffer
        // в Godot-редакторе недоступен.
        source: "/:path*",
        headers: [
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "require-corp",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/api/:path*",
          destination: `${process.env.NEXT_PUBLIC_BACKEND_URL}/:path*`,
        },
      ],
      afterFiles: [],
    };
  },
};

export default nextConfig;
