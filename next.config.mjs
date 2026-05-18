/** @type {import('next').NextConfig} */
const nextConfig = {
  // react-markdown v10+ and its whole dependency chain are ESM-only.
  // Next.js 14 needs to transpile them so the SSR pass (Node.js) can require them.
  transpilePackages: [
    'react-markdown',
    'remark-parse',
    'remark-rehype',
    'unified',
    'vfile',
    'hast-util-to-jsx-runtime',
    'mdast-util-to-hast',
    'unist-util-visit',
    'devlop',
  ],
  // Allow large media responses from Supabase Storage CDN
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: '*.supabase.in' },
    ],
  },
  // ffmpeg-static ships a native binary — exclude from server bundle tracing
  // Next.js 14 uses the experimental key; Next.js 15+ uses serverExternalPackages
  experimental: {
    // sharp is a native binary — bundling triggers "Module not found" in dev
    // when new files import it fresh. Same fix as ffmpeg/pg-boss above.
    serverComponentsExternalPackages: ['fluent-ffmpeg', 'ffmpeg-static', 'pg-boss', 'sharp'],
  },
  // Silence the "Critical dependency" warning from pg-boss
  webpack(config) {
    config.externals = [...(config.externals ?? []), { 'pg-native': 'pg-native' }]
    return config
  },
}

export default nextConfig;
