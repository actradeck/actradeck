/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  // boot smoke / 並行ビルドが稼働中 dev サーバの .next を壊さないよう、distDir を env で
  // 上書き可能にする (既定は .next)。本番ビルドの挙動は変えない (未設定時は従来どおり)。
  ...(process.env.ACTRADECK_WEBUI_DIST_DIR
    ? { distDir: process.env.ACTRADECK_WEBUI_DIST_DIR }
    : {}),
};

export default nextConfig;
