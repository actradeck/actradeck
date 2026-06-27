/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // boot smoke / 並行ビルドが稼働中 dev サーバの .next を壊さないよう、distDir を env で
  // 上書き可能にする (既定は .next)。本番ビルドの挙動は変えない (未設定時は従来どおり)。
  ...(process.env.ACTRADECK_WEBUI_DIST_DIR
    ? { distDir: process.env.ACTRADECK_WEBUI_DIST_DIR }
    : {}),
};

export default nextConfig;
