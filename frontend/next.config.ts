import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  /* config options here */
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
  // Настройка webpack для правильного разрешения модулей box2d
  // box2d использует .js расширения в импортах, но файлы на самом деле .ts
  // Используем --webpack флаг в package.json для использования webpack вместо Turbopack
  webpack: (config, { isServer }) => {
    // Настройка resolve для правильного разрешения .js импортов в TypeScript файлах
    config.resolve = config.resolve || {};
    
    // Разрешаем .js импорты как .ts файлы (для box2d)
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".jsx": [".tsx", ".jsx"],
    };
    
    // Убеждаемся, что расширения разрешаются в правильном порядке
    config.resolve.extensions = [
      ".tsx",
      ".ts",
      ".jsx",
      ".js",
      ".mjs",
      ".json",
      ...(config.resolve.extensions || []),
    ];

    return config;
  },
};

export default nextConfig;
